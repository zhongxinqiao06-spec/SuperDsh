import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import { identifier, record } from '../conversations/store.ts'

/** Server-agent file operations are confined to this user's workspace. */
export async function resolveNativePath(
  workspace: string,
  value: string,
  writing = false,
): Promise<string> {
  const root = await realpath(workspace)
  const target = path.resolve(root, value || '.')
  const within = (candidate: string) =>
    candidate === root || candidate.startsWith(root + path.sep)
  if (!within(target))
    throw new ApiError(403, 'path is outside the Agent workspace')
  let resolved: string
  try {
    resolved = await realpath(target)
  } catch (error) {
    if (!writing || record(error).code !== 'ENOENT')
      throw new ApiError(404, 'path not found')
    resolved = path.join(
      await realpath(path.dirname(target)),
      path.basename(target),
    )
  }
  if (!within(resolved))
    throw new ApiError(403, 'symbolic link leaves the Agent workspace')
  return resolved
}
interface Terminal {
  process: IPty
  view: Row
  buffer: Buffer
  sequence: number
  exited: Promise<void>
  closing?: Promise<void>
}
export class NativeDevice {
  private closed = false
  private readonly notifications = new Set<Promise<void>>()
  private readonly stopping = new WeakMap<
    ChildProcessWithoutNullStreams,
    Promise<void>
  >()
  readonly terminals = new Map<string, Terminal>()
  readonly tasks = new Set<ChildProcessWithoutNullStreams>()
  readonly workspace: string
  readonly notify: (method: string, params: Row) => Promise<void> | void
  readonly environment: Record<string, string>
  constructor(
    workspace: string,
    notify: (method: string, params: Row) => Promise<void> | void,
    environment: Record<string, string> = {},
  ) {
    this.workspace = workspace
    this.notify = notify
    this.environment = environment
  }
  async call(
    method: string,
    params: Row,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new ApiError(409, 'device has stopped')
    if (method.startsWith('fs.')) return this.file(method, params)
    if (method === 'shell.exec' || method === 'shell.task.start')
      return this.shell(params, signal)
    if (method.startsWith('terminal.'))
      return this.terminal(method, params, signal)
    throw new ApiError(422, `unsupported local device method: ${method}`)
  }
  private emit(method: string, params: Row): void {
    if (this.closed) return
    const task = Promise.resolve(this.notify(method, params))
      .then(() => undefined)
      .catch(() => undefined)
    this.notifications.add(task)
    void task.finally(() => this.notifications.delete(task))
  }
  private async file(method: string, params: Row): Promise<Row> {
    const target = await resolveNativePath(
      this.workspace,
      text(params.path, '.'),
      ['fs.write', 'fs.writeFile'].includes(method),
    )
    if (method === 'fs.readDir') {
      const entries = await readdir(target, { withFileTypes: true })
      return {
        path: target,
        entries: await Promise.all(
          entries.map(async (entry) => {
            const full = path.join(target, entry.name)
            let size = 0
            try {
              size = (await stat(full)).size
            } catch {
              /* inaccessible entries retain their name */
            }
            return {
              name: entry.name,
              path: full,
              type: entry.isDirectory()
                ? 'directory'
                : entry.isSymbolicLink()
                  ? 'symlink'
                  : 'file',
              size,
              isDirectory: entry.isDirectory(),
            }
          }),
        ),
      }
    }
    if (method === 'fs.write' || method === 'fs.writeFile') {
      if (
        typeof params.content !== 'string' ||
        (params.encoding && !['utf8', 'utf-8'].includes(text(params.encoding)))
      )
        throw new ApiError(422, 'UTF-8 text content is required')
      if (params.ifMatch) {
        const previous = await readFile(target).catch(() => Buffer.alloc(0))
        if (
          createHash('sha256').update(previous).digest('hex') !== params.ifMatch
        )
          throw new ApiError(412, 'file changed; reload before writing')
      }
      const content = Buffer.from(text(params.content), 'utf8'),
        temporary = `${target}.${identifier('write')}.tmp`
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
      return {
        path: target,
        name: path.basename(target),
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
    }
    const info = await stat(target)
    if (!info.isFile()) throw new ApiError(422, 'path must be a file')
    if (method === 'fs.openRead') {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(target)) hash.update(chunk)
      return {
        path: target,
        name: path.basename(target),
        size: info.size,
        sha256: hash.digest('hex'),
        // This method is internal to the in-process native Connector. It never
        // serializes a stream or opens a descriptor before the client downloads.
        openStream: () => createReadStream(target),
      }
    }
    if (info.size > 64 * 1024 * 1024)
      throw new ApiError(413, 'file is too large')
    const data = await readFile(target),
      sha256 = createHash('sha256').update(data).digest('hex')
    if (method === 'fs.readText') {
      const max = integer(params.maxBytes, 1_048_576, 1, 4_194_304),
        chunk = data.subarray(0, max)
      return {
        path: target,
        name: path.basename(target),
        size: data.length,
        sha256,
        encoding: 'utf8',
        content: chunk.toString('utf8'),
        binary: chunk.includes(0),
        truncated: data.length > max,
      }
    }
    return {
      path: target,
      name: path.basename(target),
      size: data.length,
      sha256,
      contentBase64: data.toString('base64'),
      createdAt: utcNow(),
    }
  }
  private async shell(params: Row, signal?: AbortSignal): Promise<Row> {
    const cwd = await resolveNativePath(this.workspace, text(params.cwd, '.'))
    const command = requiredText(params.command, 'command')
    const timeoutMs = integer(params.timeoutMs, 30_000, 1, 300_000)
    const executionSignal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ])
    if (executionSignal.aborted)
      throw new ApiError(409, 'shell request cancelled')
    const child = spawn(command, [], {
      cwd,
      env: { ...this.environment, NODE_ENV: 'production' },
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    this.tasks.add(child)
    const abort = () => {
      void this.killShell(child)
    }
    executionSignal.addEventListener('abort', abort, { once: true })
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      let size = 0
      const collect = (list: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length
        if (size <= 8 * 1024 * 1024) list.push(chunk)
        else void this.killShell(child)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.once('error', (error) => {
        executionSignal.removeEventListener('abort', abort)
        this.tasks.delete(child)
        reject(error)
      })
      child.once('close', (code) => {
        executionSignal.removeEventListener('abort', abort)
        this.tasks.delete(child)
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code,
          timedOut: executionSignal.aborted,
        })
      })
    })
  }
  private killShell(child: ChildProcessWithoutNullStreams): Promise<void> {
    const existing = this.stopping.get(child)
    if (existing) return existing
    const work = new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null) {
        resolve()
        return
      }
      if (process.platform === 'win32') {
        const terminator = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        )
        terminator.once('close', () => resolve())
        terminator.once('error', () => {
          child.kill()
          resolve()
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill()
        }
        resolve()
      }
    })
    this.stopping.set(child, work)
    return work
  }
  private async stopTerminal(terminal: Terminal): Promise<void> {
    if (terminal.closing) return terminal.closing
    terminal.closing = (async () => {
      if (terminal.view.status !== 'exited') {
        terminal.view.status = 'stopping'
        terminal.process.kill()
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        terminal.exited,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new ApiError(504, 'terminal did not exit')),
            10000,
          )
        }),
      ]).finally(() => clearTimeout(timer))
    })()
    return terminal.closing
  }
  private async terminal(
    method: string,
    params: Row,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sessionId = requiredText(params.sessionId, 'sessionId')
    if (method === 'terminal.list')
      return {
        terminals: [...this.terminals.values()]
          .filter((terminal) => terminal.view.sessionId === sessionId)
          .map((terminal) => terminal.view),
      }
    const id = text(params.terminalId, identifier('trm'))
    if (method === 'terminal.create') {
      if (this.terminals.has(id)) return this.terminals.get(id)!.view
      const cwd = await resolveNativePath(this.workspace, text(params.cwd, '.'))
      const shell = text(
        params.shell,
        process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      )
      const args = Array.isArray(params.args)
        ? params.args.map((arg) => requiredText(arg, 'terminal argument'))
        : process.platform === 'win32'
          ? ['-NoLogo', '-NoProfile']
          : ['-i']
      const cols = integer(params.cols, 80, 1, 500),
        rows = integer(params.rows, 24, 1, 200)
      const child = spawnPty(shell, args, {
        cwd,
        env: { ...this.environment, TERM: 'xterm-256color' },
        name: 'xterm-256color',
        cols,
        rows,
      })
      const view: Row = {
        terminalId: id,
        sessionId,
        root: this.workspace,
        cwd,
        label: text(params.label, 'Shell'),
        cols: integer(params.cols, 80, 1, 500),
        rows: integer(params.rows, 24, 1, 200),
        purpose: 'user',
        pid: child.pid,
        status: 'starting',
        persistent: !!params.persistent,
        scrollbackBytes: 0,
        scrollbackSeq: 0,
        createdAt: utcNow(),
      }
      let finished!: () => void
      const terminal: Terminal = {
        process: child,
        view,
        buffer: Buffer.alloc(0),
        sequence: 0,
        exited: new Promise((resolve) => {
          finished = resolve
        }),
      }
      this.terminals.set(id, terminal)
      const output = (data: Buffer) => {
        terminal.buffer = Buffer.concat([terminal.buffer, data]).subarray(
          -1024 * 1024,
        )
        terminal.sequence++
        view.scrollbackBytes = terminal.buffer.length
        view.scrollbackSeq = terminal.sequence
        this.emit('terminal.output', {
          terminalId: id,
          sessionId,
          seq: terminal.sequence,
          dataBase64: data.toString('base64'),
        })
      }
      child.onData((data) => output(Buffer.from(data)))
      child.onExit(({ exitCode }) => {
        view.status = 'exited'
        view.exitCode = exitCode
        finished()
        this.emit('terminal.exited', {
          terminalId: id,
          sessionId,
          exitCode,
        })
      })
      const deadline = Date.now() + 10000
      while (
        child.pid <= 0 &&
        view.status !== 'exited' &&
        !signal?.aborted &&
        !this.closed &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (
        child.pid <= 0 ||
        view.status === 'exited' ||
        signal?.aborted ||
        this.closed
      ) {
        await this.stopTerminal(terminal)
        throw new ApiError(502, 'terminal failed to start')
      }
      view.pid = child.pid
      view.status = 'running'
      if (params.command) child.write(`${params.command}\r`)
      return view
    }
    const terminal = this.terminals.get(id)
    if (!terminal || terminal.view.sessionId !== sessionId)
      throw new ApiError(404, 'terminal not found')
    if (method === 'terminal.close') {
      await this.stopTerminal(terminal)
    } else if (method === 'terminal.rename')
      terminal.view.label = requiredText(params.label, 'label', 64)
    else if (method === 'terminal.resize') {
      const cols = integer(params.cols, 80, 1, 500),
        rows = integer(params.rows, 24, 1, 200)
      terminal.process.resize(cols, rows)
      terminal.view.cols = cols
      terminal.view.rows = rows
    } else if (
      method === 'terminal.setPersistence' ||
      method === 'terminal.setPersistent'
    )
      terminal.view.persistent = !!params.persistent
    else if (method === 'terminal.write' || method === 'terminal.input')
      terminal.process.write(
        params.dataBase64
          ? Buffer.from(text(params.dataBase64), 'base64').toString('utf8')
          : text(params.data),
      )
    else if (method === 'terminal.snapshot')
      return {
        ...terminal.view,
        dataBase64: terminal.buffer.toString('base64'),
        seq: terminal.sequence,
      }
    else if (
      method === 'terminal.subscribe' ||
      method === 'terminal.unsubscribe'
    )
      return { ok: true }
    else throw new ApiError(422, `unsupported terminal method: ${method}`)
    return terminal.view
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.terminals.values()].map((terminal) =>
        this.stopTerminal(terminal),
      ),
    )
    await Promise.allSettled(
      [...this.tasks].map((task) => this.killShell(task)),
    )
    this.terminals.clear()
    this.tasks.clear()
    await Promise.allSettled(this.notifications)
  }
}
