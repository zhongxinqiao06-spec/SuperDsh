/** Platform identities select credentials; every identity uses the original local Home. */
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  atomicJson,
  privateDirectory,
  readPrivateFile,
} from '../backend/private-files.ts'

export function platformOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('平台地址必须是 HTTPS 根地址；本机开发服务可使用 HTTP。')
  }
  return url.origin
}
export function accountSpaceKey(origin: string, userId: string): string {
  if (!userId || userId.length > 512)
    throw new Error('Invalid platform identity')
  return createHash('sha256')
    .update(`${platformOrigin(origin)}\n${userId}`)
    .digest('hex')
}
export class PlatformSpaces {
  readonly root: string
  private selectedKey: string | null
  readonly home: string
  constructor(
    defaultHome: string,
    readonly localHome: string,
  ) {
    this.root = join(dirname(defaultHome), 'platform-spaces')
    const file = join(this.root, 'selected.json')
    const raw = readPrivateFile(file)
    const saved: unknown = raw === undefined ? null : JSON.parse(raw)
    if (
      saved !== null &&
      (typeof saved !== 'object' ||
        !('key' in saved) ||
        (saved.key !== null &&
          (typeof saved.key !== 'string' || !/^[a-f0-9]{64}$/.test(saved.key))))
    )
      throw new Error('Invalid selected account space')
    this.selectedKey =
      saved === null ? null : (saved as { key: string | null }).key
    this.home = resolve(localHome)
  }
  get selected(): string | null {
    return this.selectedKey
  }
  directoryFor(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid identity key')
    return join(this.root, key)
  }
  /** Old account Homes are retained for explicit migration; never activated automatically. */
  homeFor(key: string): string {
    return join(this.directoryFor(key), 'home')
  }
  select(key: string | null): void {
    if (key !== null) privateDirectory(this.directoryFor(key))
    privateDirectory(this.root)
    atomicJson(join(this.root, 'selected.json'), { version: 2, key })
    this.selectedKey = key
  }
}
