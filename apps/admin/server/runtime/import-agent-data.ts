import { createHash, randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { relocateImportedAgent } from './import-agent-relocation.ts'

export interface AgentDataImportOptions {
  /** Offline exported volume with home/, workspace/ and optional connector/. */
  sourceDirectory: string
  rootDirectory: string
  ownerUserId: string
  connectorId: string
  /** Cancel copying if the platform ownership lease is lost. Rollback still runs. */
  signal?: AbortSignal
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  )
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Import paths must be real directories, not links')
}

async function assertOffline(source: string): Promise<void> {
  for (const name of ['.lock', 'home/.lock', 'connector/.lock'])
    if (await exists(join(source, name)))
      throw new Error(
        'Source has an active or unresolved data lock; stop the source before export',
      )
  const endpoint = join(
    source,
    'home',
    'agents-anywhere',
    'bridge',
    'endpoint.json',
  )
  if (!(await exists(endpoint))) return
  const info = await lstat(endpoint)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
    throw new Error('Invalid exported Bridge endpoint')
  const value = JSON.parse(await readFile(endpoint, 'utf8')) as Record<
    string,
    unknown
  >
  if (
    value.host !== '127.0.0.1' ||
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535
  )
    throw new Error('Invalid exported Bridge endpoint')
  const active = await new Promise<boolean>((resolve) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port: Number(value.port),
    })
    const finish = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
  if (active)
    throw new Error(
      'Source Bridge may still be active; stop the source before export',
    )
}

/** Explicit offline copy only. Never touches Docker, SQL, source files or existing native data. */
export async function importAgentData(
  options: AgentDataImportOptions,
): Promise<{
  directory: string
  copiedFiles: number
  skipped: string[]
  relocatedSessions: number
}> {
  options.signal?.throwIfAborted()
  if (
    !options.ownerUserId.trim() ||
    options.ownerUserId.length > 200 ||
    /[\x00-\x1f]/.test(options.ownerUserId)
  )
    throw new Error('A stable owner user ID is required')
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.connectorId))
    throw new Error('A valid existing Connector ID is required')
  if (
    !isAbsolute(options.sourceDirectory) ||
    !isAbsolute(options.rootDirectory)
  )
    throw new Error('Import directories must be absolute paths')
  const source = resolve(options.sourceDirectory)
  const root = resolve(options.rootDirectory)
  if (contained(source, root) || contained(root, source))
    throw new Error('Source and native root must not overlap')
  await realDirectory(source)
  for (const name of ['home', 'workspace'])
    await realDirectory(join(source, name))
  await mkdir(root, { recursive: true, mode: 0o700 })
  await realDirectory(root)
  const realSource = await realpath(source)
  const realRoot = await realpath(root)
  if (contained(realSource, realRoot) || contained(realRoot, realSource))
    throw new Error('Resolved import directories must not overlap')
  const digest = createHash('sha256').update(options.ownerUserId).digest('hex')
  const target = join(root, digest)
  const lockPath = join(root, `.import-${digest}.lock`)
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error(
      'An import for this user is already running or requires lock recovery',
    )
  })
  const stage = join(
    root,
    `.import-${digest}-${randomBytes(12).toString('hex')}`,
  )
  if (
    dirname(stage) !== root ||
    !basename(stage).startsWith(`.import-${digest}-`)
  )
    throw new Error('Invalid import rollback boundary')
  let staged = false
  let removedEmptyTarget = false
  let committed = false
  let copiedFiles = 0
  const skipped: string[] = []
  try {
    if (await exists(target)) {
      await realDirectory(target)
      if ((await readdir(target)).length)
        throw new Error(
          'Native target must be empty; existing data is never merged or overwritten',
        )
    }
    await assertOffline(source)
    await mkdir(stage, { mode: 0o700 })
    staged = true
    const copyTree = async (
      from: string,
      to: string,
      key: string,
    ): Promise<void> => {
      options.signal?.throwIfAborted()
      if (
        basename(from) === 'node_modules' ||
        key === 'home/agents-anywhere/bridge/endpoint.json' ||
        key === 'connector/runtime.json'
      ) {
        skipped.push(key)
        return
      }
      const before = await lstat(from)
      if (before.isSymbolicLink())
        throw new Error(
          'Export contains a symbolic link; export real files before importing',
        )
      if (before.isDirectory()) {
        await mkdir(to, { mode: 0o700 })
        for (const name of await readdir(from))
          await copyTree(join(from, name), join(to, name), `${key}/${name}`)
      } else if (before.isFile()) {
        await copyFile(from, to)
        await chmod(to, before.mode & 0o700)
        const after = await lstat(from)
        options.signal?.throwIfAborted()
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino
        )
          throw new Error(
            'Source changed during import; stop the source and export again',
          )
        copiedFiles++
      } else
        throw new Error(
          'Export contains a special file; only ordinary files and directories can be imported',
        )
    }
    for (const name of ['home', 'workspace', 'connector']) {
      if (await exists(join(source, name)))
        await copyTree(join(source, name), join(stage, name), name)
      else await mkdir(join(stage, name), { mode: 0o700 })
    }
    await assertOffline(source)
    options.signal?.throwIfAborted()
    const relocatedSessions = await relocateImportedAgent(
      stage,
      target,
      options.signal,
    )
    await writeFile(
      join(stage, 'native-runtime.json'),
      JSON.stringify({
        version: 1,
        storage: 'native',
        ownerUserId: options.ownerUserId,
        connectorId: options.connectorId,
      }),
      { flag: 'wx', mode: 0o600 },
    )
    // Recheck immediately before the commit; never remove a nonempty target.
    if (await exists(target)) {
      await realDirectory(target)
      await rmdir(target)
      removedEmptyTarget = true
    }
    options.signal?.throwIfAborted()
    await rename(stage, target)
    committed = true
    return { directory: target, copiedFiles, skipped, relocatedSessions }
  } finally {
    if (staged && !committed) {
      await rm(stage, { recursive: true, force: true })
    }
    if (removedEmptyTarget && !committed)
      await mkdir(target, { mode: 0o700 }).catch(() => {})
    await lock.close()
    await rm(lockPath, { force: true })
  }
}
