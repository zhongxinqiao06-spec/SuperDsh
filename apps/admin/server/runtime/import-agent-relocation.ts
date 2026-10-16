import { createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const HEADER_LIMIT = 1024 * 1024

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid exported Harness metadata')
  return value as Record<string, unknown>
}

/** Pinned Harness JSONL project-key format; metadata and its directory must agree. */
function projectKey(path: string): string {
  let readable = ''
  let separator = false
  for (let index = 0; index < path.length; index++) {
    const char = path[index]!
    if ('/\\:'.includes(char)) {
      if (!separator) readable += '-'
      separator = true
    } else {
      readable += /^[A-Za-z0-9._-]$/.test(char)
        ? char
        : `~${path.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
      separator = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function nativeWorkspace(path: unknown, workspace: string): string | undefined {
  if (typeof path !== 'string') return undefined
  if (path !== '/workspace' && !path.startsWith('/workspace/')) return undefined
  if (/[\\:\0]/.test(path))
    throw new Error(
      'Exported workspace metadata contains an unsupported path separator',
    )
  const canonical = posix.normalize(path)
  if (canonical !== '/workspace' && !canonical.startsWith('/workspace/'))
    throw new Error('Exported workspace metadata escapes its original root')
  return join(workspace, canonical.slice('/workspace'.length))
}

function sessionSegment(id: string): string {
  if (!id) throw new Error('Exported session ID must not be empty')
  if (id === '.' || id === '..') return id.replaceAll('.', '~002E')
  let value = ''
  for (let index = 0; index < id.length; index++) {
    const char = id[index]!
    value += /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `~${id.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return value
}

/** Locate only the first standard Zstd frame; the remaining event frames stay byte-identical. */
function firstFrameLength(bytes: Buffer): number {
  const required = (end: number) => {
    if (end > bytes.length)
      throw new Error('Exported session header is incomplete or too large')
  }
  required(5)
  if (bytes.readUInt32LE(0) !== 0xfd2fb528)
    throw new Error('Invalid exported session Zstandard header')
  const flags = bytes[4]!
  if (flags & 0x18) throw new Error('Invalid exported session Zstandard flags')
  const single = Boolean(flags & 0x20)
  const sizeFlag = flags >>> 6
  const dictionaryFlag = flags & 3
  let offset =
    5 + (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
  offset += sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag
  required(offset)
  for (;;) {
    required(offset + 3)
    const block = bytes.readUIntLE(offset, 3)
    const type = (block >>> 1) & 3
    if (type === 3) throw new Error('Invalid exported session Zstandard block')
    offset += 3 + (type === 1 ? 1 : block >>> 3)
    required(offset)
    if (block & 1) break
  }
  if (flags & 4) offset += 4
  required(offset)
  return offset
}

async function relocateLog(
  file: string,
  workspace: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const handle = await open(file, 'r')
  const prefix = Buffer.alloc(HEADER_LIMIT)
  let bytes: Buffer
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    bytes = prefix.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const compressed = file.endsWith('.zstd')
  const consumed = compressed ? firstFrameLength(bytes) : bytes.indexOf(10) + 1
  if (!consumed)
    throw new Error('Exported session header is incomplete or too large')
  const headerBytes = compressed
    ? zstdDecompressSync(bytes.subarray(0, consumed), {
        maxOutputLength: HEADER_LIMIT,
      })
    : bytes.subarray(0, consumed)
  if (headerBytes.indexOf(10) !== headerBytes.length - 1)
    throw new Error('Exported session first frame must contain only its header')
  const header = object(JSON.parse(headerBytes.toString('utf8')))
  if (
    header.type !== 'session' ||
    header.version !== 4 ||
    typeof header.id !== 'string'
  )
    throw new Error(
      'Only pinned Harness v4 session headers support workspace relocation',
    )
  const cwd = nativeWorkspace(header.cwd, workspace)
  if (!cwd) return undefined
  const sourceProject = projectKey(String(header.cwd))
  header.cwd = cwd
  const line = Buffer.from(`${JSON.stringify(header)}\n`)
  const output = compressed
    ? zstdCompressSync(line, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    : line
  const temporary = `${file}.native-import`
  await writeFile(temporary, output, { flag: 'wx', mode: 0o600 })
  await pipeline(
    createReadStream(file, { start: consumed }),
    createWriteStream(temporary, { flags: 'a', mode: 0o600 }),
    { signal },
  )
  signal?.throwIfAborted()
  await rename(temporary, file)
  return {
    sourceProject,
    targetProject: projectKey(cwd),
    session: sessionSegment(header.id as string),
  }
}

/** Transform only the unpublished copy. Conversation events and the exported source are never rewritten. */
export async function relocateImportedAgent(
  stage: string,
  target: string,
  signal?: AbortSignal,
): Promise<number> {
  const workspace = join(target, 'workspace')
  const sessions = join(stage, 'home', 'sessions')
  let relocated = 0
  const projects = await readdir(sessions, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(sessions, project.name), {
      withFileTypes: true,
    })) {
      if (!session.isDirectory()) continue
      const directory = join(sessions, project.name, session.name)
      const files = await readdir(directory)
      const generations = files.flatMap((file) => {
        const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(
          file,
        )
        return match ? [Number(match[1] ?? 0)] : []
      })
      if (generations.length && Math.max(...generations) !== 4)
        throw new Error(
          '导出的会话格式不是当前 Harness v4，请先用原版本完成会话升级再重新导出；本次导入未提交。',
        )
      if (
        files.includes('session.v4.jsonl') &&
        files.includes('session.v4.jsonl.zstd')
      )
        throw new Error(
          'Export contains conflicting session compression formats',
        )
      let destination: string | undefined
      for (const file of files) {
        if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(file)) continue
        const mapped = await relocateLog(
          join(directory, file),
          workspace,
          signal,
        )
        if (!mapped) continue
        if (
          mapped.session !== session.name ||
          mapped.sourceProject !== project.name ||
          (destination && destination !== mapped.targetProject)
        )
          throw new Error(
            'Exported session header does not match its workspace directory',
          )
        destination = mapped.targetProject
      }
      if (!destination) continue
      const next = join(sessions, destination, session.name)
      if (next !== directory) {
        await mkdir(dirname(next), { recursive: true, mode: 0o700 })
        const occupied = await lstat(next).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          },
        )
        if (occupied)
          throw new Error('Relocated session directory already exists')
        await rename(directory, next)
      }
      relocated++
    }
  }
  const registry = join(stage, 'home', 'storages', 'workspace.json')
  const registryText = await readFile(registry, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (registryText !== undefined) {
    const document = object(JSON.parse(registryText))
    if (object(document.unit).name !== 'workspace')
      throw new Error('Invalid exported workspace registry')
    const workspaces = object(object(document.tables).workspaces ?? {})
    let changed = false
    for (const item of Object.values(workspaces)) {
      const record = object(item)
      const path = nativeWorkspace(record.path, workspace)
      if (!path) continue
      record.path = path
      changed = true
    }
    if (changed)
      await writeFile(registry, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
      })
  }
  if (relocated) {
    // Derived folds are bound to header.cwd and must rebuild from the unchanged events.
    await rm(join(stage, 'home', 'storages', 'session_projcache'), {
      recursive: true,
      force: true,
    })
    await rm(join(stage, 'home', 'storages', 'session_projcache.json'), {
      force: true,
    })
  }
  return relocated
}
