import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DesktopImportError } from '../../contracts/import-types.ts'

export interface ImportFile {
  path: string
  size: number
  sha256: string
}
export const RECEIPT = 'superdsh-import.json'
export const IMPORT_PENDING = '.superdsh-import-pending.json'
const generated = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'desktop-next.runtime.patch.json',
  'desktop-next.cordis.patch.json',
])
const installConfiguration = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'pnpmfile.cjs',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  '.pnp.cjs',
  '.pnp.loader.mjs',
])
const ignoredRoots = new Set([
  'logs',
  'cache',
  'caches',
  '.cache',
  'diagnostics',
  'crash-evidence',
  'recovery',
  'agents-anywhere',
  '.agents-anywhere',
  'electron-user-data',
])
const credentials = new Set([
  '.credentials.yaml',
  '.credentials.yml',
  '.auth.json',
  'account.enc.json',
  'binding.enc.json',
  'credentials',
  'credentials.json',
  'auth.json',
  'oauth.json',
  '.env',
  '.env.local',
  '.env.production',
])
export const isLock = (name: string) =>
  name === 'lock' ||
  name.endsWith('.lock') ||
  /^Singleton(?:Lock|Cookie|Socket)$/u.test(name)
export function excluded(path: string): boolean {
  const parts = path.split('/')
  return (
    parts.includes('node_modules') ||
    parts.includes('.git') ||
    parts.includes('.pnpm-store') ||
    ignoredRoots.has(parts[0]!) ||
    parts[0] === 'platform-connector' ||
    parts.some(
      (part) => part === 'agents-anywhere' || part === '.agents-anywhere',
    ) ||
    parts.some(
      (part) =>
        /^\.env(?:\..*)?$/.test(part) || /\.(?:pem|p12|pfx|key)$/.test(part),
    ) ||
    parts.some((part) => credentials.has(part)) ||
    generated.has(parts.at(-1)!) ||
    installConfiguration.has(parts.at(-1)!) ||
    isLock(parts.at(-1)!) ||
    path === RECEIPT ||
    path === IMPORT_PENDING
  )
}
export function canonicalPath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    Buffer.byteLength(path) > 32_768
  ) {
    throw new DesktopImportError('invalid-path', '请选择完整的本地绝对路径。')
  }
  const result = resolve(path)
  if (result === parse(result).root)
    throw new DesktopImportError(
      'invalid-path',
      '不能将磁盘根目录作为数据目录。',
    )
  return result
}
export async function assertRealPath(
  path: string,
  allowMissing = false,
): Promise<void> {
  const parent = dirname(path)
  if (parent !== path) await assertRealPath(parent)
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new DesktopImportError(
        'unsafe-path',
        `目录不能是符号链接或特殊文件：${path}`,
      )
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return
    throw error
  }
}
const comparison = (path: string) =>
  process.platform === 'win32' ? path.toLowerCase() : path
export function isInside(parent: string, child: string): boolean {
  const part = relative(comparison(parent), comparison(child))
  return (
    part === '' ||
    (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
  )
}
export async function validateLocations(
  source: string,
  target: string,
): Promise<{ sourceHome: string; targetHome: string }> {
  source = canonicalPath(source)
  target = canonicalPath(target)
  await assertRealPath(source)
  await assertRealPath(target, true)
  source = await realpath(source)
  const parent = await realpath(dirname(target))
  target = join(parent, relative(dirname(target), target))
  if (isInside(source, target) || isInside(target, source))
    throw new DesktopImportError(
      'path-conflict',
      '源目录与目标目录必须不同，且不能互相包含。',
    )
  return { sourceHome: source, targetHome: target }
}
export async function assertEmptyTarget(target: string): Promise<boolean> {
  await assertRealPath(target, true)
  try {
    if ((await readdir(target)).length)
      throw new DesktopImportError(
        'target-not-empty',
        '目标目录已有内容。请选择一个新的空目录。',
      )
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DesktopImportError('cancelled', '导入已取消；源数据没有改变。')
}
export async function treeFiles(
  root: string,
  skipped: string[] = [],
): Promise<string[]> {
  await assertRealPath(root)
  const files: string[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    await assertRealPath(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excluded(path)) {
        skipped.push(path)
        continue
      }
      const full = join(root, ...path.split('/'))
      const info = await lstat(full)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new DesktopImportError(
          'unsafe-file',
          `数据中包含符号链接或特殊文件：${path}`,
        )
      if (info.isDirectory()) await walk(full, path)
      else files.push(path)
      if (files.length > 200_000)
        throw new DesktopImportError(
          'too-many-files',
          '数据文件过多，请先缩小导入范围。',
        )
    }
  }
  await walk(root, '')
  return files.sort()
}
/** Read through a checked descriptor; copy into a newly created private file. */
export async function digestFile(
  root: string,
  path: string,
  destination?: string,
  signal?: AbortSignal,
): Promise<ImportFile> {
  checkAbort(signal)
  const source = join(root, ...path.split('/'))
  await assertRealPath(dirname(source))
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink())
    throw new DesktopImportError('unsafe-file', `文件类型已改变：${path}`)
  const handle = await open(
    source,
    constants.O_RDONLY |
      (process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  )
  try {
    const initial = await handle.stat()
    if (
      !initial.isFile() ||
      initial.ino !== before.ino ||
      initial.dev !== before.dev
    )
      throw new DesktopImportError(
        'source-changed',
        `源文件在检查后改变：${path}`,
      )
    const hash = createHash('sha256')
    const input = handle.createReadStream({ autoClose: false })
    if (destination !== undefined) {
      const target = join(destination, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await assertRealPath(dirname(target))
      const digest = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        input,
        digest,
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
        { signal },
      )
    } else {
      for await (const chunk of input) {
        checkAbort(signal)
        hash.update(chunk)
      }
    }
    const after = await handle.stat()
    if (
      initial.size !== after.size ||
      initial.mtimeMs !== after.mtimeMs ||
      initial.ctimeMs !== after.ctimeMs
    )
      throw new DesktopImportError(
        'source-changed',
        `源文件正在被修改：${path}`,
      )
    return { path, size: after.size, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}
export async function fingerprint(
  root: string,
  signal?: AbortSignal,
): Promise<ImportFile[]> {
  const result: ImportFile[] = []
  for (const path of await treeFiles(root))
    result.push(await digestFile(root, path, undefined, signal))
  return result
}
export function sameFiles(left: ImportFile[], right: ImportFile[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
export function snapshotDigest(files: ImportFile[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}
