/** Restore execute bits without running uv's host-only postinstall or copying extra binaries. */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aaWorkspaceTargets } from './agents-anywhere-release-policy.mjs'

export function prepareInstalledAaRuntime(
  root,
  platform = process.platform,
  options = {},
) {
  if (platform === 'win32') return
  for (const { workspace } of aaWorkspaceTargets(options)) {
    const scope = join(root, workspace, 'node_modules', '@dataiku')
    if (!existsSync(scope)) continue
    for (const name of readdirSync(scope)) {
      if (name.startsWith(`uv-${platform}-`))
        chmodSync(join(scope, name, 'bin', 'uv'), 0o755)
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareInstalledAaRuntime(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    process.platform,
    { legacy: process.argv.includes('--legacy') },
  )
}
