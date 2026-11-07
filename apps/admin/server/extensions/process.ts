import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ApiError } from '../http/api-router.ts'
import { packagePath } from './validation.ts'

export function withinDirectory(root: string, target: string) {
  const path = relative(resolve(root), resolve(target))
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  )
}

export async function installedEntrypoint(root: string, entry: string) {
  const directory = await realpath(root)
  const path = await realpath(resolve(root, packagePath(entry)))
  if (!withinDirectory(directory, path))
    throw new ApiError(422, '扩展入口越出安装目录')
  return path
}

/** Explicitly limited environment, not an OS sandbox. Installed executables are administrator-trusted code. */
export function toolEnvironment(directory: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'TZ',
  ])
    if (process.env[name]) env[name] = process.env[name]!
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

export async function stopToolProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      )
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

export async function runToolProcess(options: {
  installation: string
  entrypoint: string
  runtime: 'node' | 'python'
  workRoot: string
  input: Record<string, unknown>
  timeoutSeconds: number
  signal: AbortSignal
}): Promise<Record<string, unknown>> {
  options.signal.throwIfAborted()
  const entry = await installedEntrypoint(
    options.installation,
    options.entrypoint,
  )
  await mkdir(options.workRoot, { recursive: true })
  const directory = await mkdtemp(join(options.workRoot, 'tool-'))
  try {
    const executable =
      options.runtime === 'node'
        ? process.execPath
        : join(
            options.installation,
            '.venv',
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
          )
    return await new Promise((done, reject) => {
      const child = spawn(executable, [entry], {
        cwd: directory,
        env: toolEnvironment(directory),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
      const parts: Buffer[] = []
      let size = 0,
        settled = false
      let failure: Error | undefined
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        child.stdin.destroy()
        if (error) reject(error)
        else done(result ?? {})
      }
      const stop = (error: Error) => {
        if (failure || settled) return
        failure = error
        void stopToolProcess(child).catch(() => child.kill('SIGKILL'))
      }
      const abort = () => stop(new ApiError(499, '工具调用已取消'))
      const timer = setTimeout(
        () => stop(new ApiError(504, '工具执行超时')),
        options.timeoutSeconds * 1000,
      )
      options.signal.addEventListener('abort', abort, { once: true })
      child.on('error', () =>
        finish(new ApiError(503, '工具运行环境不可用，请检查扩展安装状态')),
      )
      child.stdout.on('data', (part: Buffer) => {
        size += part.length
        if (size > 32 * 1024 * 1024) stop(new ApiError(413, '工具返回内容过大'))
        else parts.push(part)
      })
      // Tool stderr can contain input/secrets. Never forward it to clients or platform logs.
      child.stderr.resume()
      child.on('close', (code) => {
        if (settled) return
        if (failure) return finish(failure)
        if (code !== 0)
          return finish(
            new ApiError(502, '扩展工具执行失败；请检查包内工具诊断'),
          )
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(parts).toString('utf8'),
          )
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('result')
          finish(undefined, value as Record<string, unknown>)
        } catch {
          finish(new ApiError(502, '扩展必须返回单个 JSON 对象'))
        }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(
        JSON.stringify({ protocolVersion: 1, ...options.input }) + '\n',
      )
      if (options.signal.aborted) abort()
    })
  } finally {
    if (dirname(directory) === resolve(options.workRoot))
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}
