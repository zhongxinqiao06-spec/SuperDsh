import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { ExtensionManifest } from '@superdsh/core/contracts/extensions'
import { ApiError } from '../http/api-router.ts'
import { packagePath, validateManifest } from './validation.ts'
import {
  installedEntrypoint,
  runToolProcess,
  stopToolProcess,
  toolEnvironment,
} from './process.ts'
import { discoverMcp, withMcp } from './mcp.ts'

const installationRecord = '.superdsh-install.json'

function pythonInstaller() {
  const require = createRequire(import.meta.url)
  try {
    const anchor = require.resolve('@dataiku/uv/package.json')
    const binary = createRequire(anchor).resolve(
      `@dataiku/uv-${process.platform}-${process.arch}/package.json`,
    )
    return join(
      dirname(binary),
      'bin',
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    )
  } catch {
    throw new ApiError(503, '产品缺少当前平台的 uv，请重新安装锁定依赖')
  }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function prepareDependencies(
  directory: string,
  runtime: ExtensionManifest['runtime'],
  signal: AbortSignal,
  runtimeDirectory: string,
) {
  const python = runtime === 'python'
  const declaration = join(
    directory,
    python ? 'pyproject.toml' : 'package.json',
  )
  if (!(await exists(declaration))) {
    if (python)
      throw new ApiError(422, 'Python 工具包需要 pyproject.toml 与 uv.lock')
    return
  }
  if (
    !(await exists(join(directory, python ? 'uv.lock' : 'package-lock.json')))
  )
    throw new ApiError(422, '工具依赖需要固定的 uv.lock 或 package-lock.json')
  const command = python ? pythonInstaller() : process.execPath
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!python && !(await exists(npm)))
    throw new ApiError(503, 'Node 安装环境缺少 npm，无法准备扩展依赖')
  const commands = python
    ? [
        ['venv', '--relocatable', '--python', '3.12', join(directory, '.venv')],
        [
          'sync',
          '--locked',
          '--no-dev',
          '--python',
          '3.12',
          '--project',
          directory,
        ],
      ]
    : [[npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']]
  const environment = {
    ...toolEnvironment(directory),
    UV_PYTHON_INSTALL_DIR: join(runtimeDirectory, 'python'),
    UV_CACHE_DIR: join(runtimeDirectory, 'uv-cache'),
    UV_PYTHON_INSTALL_BIN: 'false',
  }
  for (const args of commands) {
    signal.throwIfAborted()
    await new Promise<void>((done, reject) => {
      const child = spawn(command, args, {
        cwd: directory,
        env: environment,
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: 'ignore',
      })
      let failure: Error | undefined
      const abort = () => {
        failure ??= new ApiError(
          signal.aborted ? 499 : 504,
          '扩展依赖准备已取消或超时',
        )
        void stopToolProcess(child).catch(() => child.kill('SIGKILL'))
      }
      const timer = setTimeout(abort, 180000)
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', () => {
        failure ??= new ApiError(503, '扩展依赖管理器不可用，请安装 npm 或 uv')
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (failure) reject(failure)
        else if (code !== 0)
          reject(new ApiError(422, '锁定依赖安装失败，未替换当前可用扩展'))
        else done()
      })
      if (signal.aborted) abort()
    })
  }
}

export async function installArchive(options: {
  root: string
  bytes: Buffer
  signal: AbortSignal
}) {
  if (!options.bytes.length || options.bytes.length > 16 * 1024 * 1024)
    throw new ApiError(413, '扩展包大小限制为 16 MiB')
  const root = resolve(options.root)
  await mkdir(root, { recursive: true })
  const stage = await mkdtemp(join(root, '.install-'))
  let installed = false
  let candidate: string | undefined
  try {
    const zip = await JSZip.loadAsync(options.bytes)
    const entries = Object.values(zip.files)
    if (entries.length > 3000) throw new ApiError(413, '扩展包文件过多')
    let total = 0
    const names = new Set<string>()
    for (const entry of entries) {
      options.signal.throwIfAborted()
      const raw = entry.unsafeOriginalName || entry.name
      const path = packagePath(raw.replace(/\/$/u, ''))
      if (path.toLowerCase() === installationRecord)
        throw new ApiError(422, '扩展包不能携带产品安装状态')
      if (names.has(path.toLowerCase()))
        throw new ApiError(422, '扩展包包含大小写冲突或重复文件')
      names.add(path.toLowerCase())
      if (
        path
          .split('/')
          .some((part) => ['.git', '.venv', 'node_modules'].includes(part))
      )
        throw new ApiError(422, '扩展包不能携带机器缓存、Git 目录或已安装依赖')
      const mode =
        typeof entry.unixPermissions === 'string'
          ? parseInt(entry.unixPermissions, 8)
          : (entry.unixPermissions ?? 0)
      if ((mode & 0o170000) === 0o120000)
        throw new ApiError(422, '扩展包不能包含符号链接')
      if (entry.dir) {
        await mkdir(join(stage, path), { recursive: true })
        continue
      }
      // Check advertised lengths before inflation; stream also bounds dishonest archives.
      const stream = new Readable({ read() {} }).wrap(entry.nodeStream())
      const chunks: Buffer[] = []
      for await (const data of stream) {
        const chunk = Buffer.from(data)
        total += chunk.length
        if (total > 64 * 1024 * 1024) {
          stream.destroy()
          throw new ApiError(413, '扩展解压大小超过 64 MiB')
        }
        chunks.push(chunk)
      }
      await mkdir(dirname(join(stage, path)), { recursive: true })
      await writeFile(join(stage, path), Buffer.concat(chunks), { flag: 'wx' })
    }
    let raw: unknown
    try {
      raw = JSON.parse(
        await readFile(join(stage, 'superdsh-extension.json'), 'utf8'),
      )
    } catch {
      throw new ApiError(422, '扩展缺少有效的 superdsh-extension.json')
    }
    const manifest = validateManifest(raw)
    await installedEntrypoint(stage, manifest.entrypoint)
    for (const skill of manifest.skills ?? [])
      await installedEntrypoint(stage, skill.entrypoint)
    const digest = createHash('sha256').update(options.bytes).digest('hex')
    const destination = join(root, manifest.id, manifest.version, digest)
    if (await exists(destination)) {
      const completed = await readFile(
        join(destination, installationRecord),
        'utf8',
      ).then(
        (value) => JSON.parse(value) as { digest?: string; manifest?: unknown },
        () => null,
      )
      if (completed?.digest !== digest || !completed.manifest)
        throw new ApiError(
          409,
          '此扩展版本的安装尚未完成，不能启用；请检查安装任务',
        )
      return {
        manifest: validateManifest(completed.manifest),
        digest,
        directory: destination,
      }
    }
    await prepareDependencies(
      stage,
      manifest.runtime,
      options.signal,
      join(root, '.runtimes'),
    )
    await mkdir(dirname(destination), { recursive: true })
    await rename(stage, destination)
    candidate = destination
    // Validate at the final path. A stage-only health check misses broken Python
    // interpreters or dependency scripts after moving a prepared installation.
    if (manifest.runtime === 'mcp-stdio') {
      await withMcp(
        {
          kind: 'stdio',
          installation: destination,
          entrypoint: manifest.entrypoint,
          workDirectory: destination,
        },
        options.signal,
        async (client) => {
          const discovered = await discoverMcp(client, options.signal)
          for (const tool of manifest.tools) {
            const actual = discovered.find((item) => item.id === tool.id)
            if (
              !actual ||
              JSON.stringify(actual.inputSchema) !==
                JSON.stringify(tool.inputSchema)
            )
              throw new ApiError(422, `MCP 工具 ${tool.id} 与包清单不一致`)
            tool.remoteName = actual.remoteName
          }
        },
      )
    } else {
      const health = await runToolProcess({
        installation: destination,
        entrypoint: manifest.entrypoint,
        runtime: manifest.runtime,
        workRoot: join(root, '.checks'),
        input: { operation: 'health' },
        timeoutSeconds: 30,
        signal: options.signal,
      })
      if (health.ok !== true)
        throw new ApiError(422, '扩展健康检查失败，未替换当前可用版本')
    }
    await writeFile(
      join(destination, installationRecord),
      JSON.stringify({ digest, manifest }),
      { flag: 'wx' },
    )
    installed = true
    return { manifest, digest, directory: destination }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (options.signal.aborted) throw new ApiError(499, '扩展安装已取消')
    throw new ApiError(422, '扩展包无法安装，请检查清单、文件和运行依赖')
  } finally {
    if (!installed && dirname(stage) === root)
      await rm(stage, { recursive: true, force: true, maxRetries: 3 })
    if (
      !installed &&
      candidate &&
      candidate.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))
    )
      await rm(candidate, { recursive: true, force: true, maxRetries: 3 })
  }
}
