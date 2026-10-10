import { chmodSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Windows checkouts can lose the POSIX executable bit before native packaging. */
export function prepareNodeShim(
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
  chmod: typeof chmodSync = chmodSync,
): void {
  if (platform === 'win32') return
  const root = realpathSync(desktopRoot)
  const shim = join(root, 'scripts', 'node-bin', 'node')
  if (!lstatSync(shim).isFile() || realpathSync(shim) !== shim) {
    throw new Error(
      'The SuperDsh Node shim must be a regular file inside the desktop package',
    )
  }
  chmod(shim, 0o755)
}
