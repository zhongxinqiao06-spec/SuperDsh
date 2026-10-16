import path from 'node:path'
import { ApiError } from '../http/api-router.ts'

/** Use the same identity for registered workspaces and projected histories. */
export function workspaceIdentity(value: string, deviceOs?: unknown) {
  const windows =
    deviceOs === 'windows' ||
    deviceOs === 'win32' ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  const platform = windows ? path.win32 : path.posix
  if (!platform.isAbsolute(value))
    throw new ApiError(422, 'workspacePath must be an absolute path')
  const normalized = platform.normalize(value)
  const root = platform.parse(normalized).root
  const display =
    normalized.length > root.length
      ? normalized.replace(windows ? /[\\/]+$/ : /\/+$/, '')
      : normalized
  return {
    display,
    key: windows ? display.replaceAll('\\', '/').toLowerCase() : display,
    name: platform.basename(display) || 'Workspace',
  }
}
