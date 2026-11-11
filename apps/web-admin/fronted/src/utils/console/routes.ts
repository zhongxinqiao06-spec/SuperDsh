import { canOpenModule, consoleModules } from '@/utils/console/modules'

const aliases: Record<string, string> = {
  '/app': '/overview',
  '/dashboard': '/overview',
  '/team': '/access/users',
  '/service': '/system/service',
  '/settings': '/account/profile',
  '/settings/account': '/account/profile',
  '/settings/appearance': '/account/appearance',
  '/settings/personal-models': '/account/models',
  '/settings/mobile-connections': '/account/mobile',
  '/mobile-connections': '/account/mobile',
  '/settings/archived-sessions': '/workspace/archived',
}

/** 仅转换登记的站内旧Hash路径，不接受外部URL作为登录后跳转。 */
export function canonicalPath(
  path: string,
  permissions: readonly string[] = [],
): string | null {
  if (
    path.length > 8192 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[?#\\]/.test(path)
  )
    return null
  if (aliases[path]) return aliases[path]
  if (path === '/management')
    return (
      consoleModules.find(
        (item) =>
          [
            'access.users',
            'access.roles',
            'access.menus',
            'devices',
            'models',
            'system.audit',
          ].includes(item.id) && canOpenModule(item, permissions),
      )?.path ?? '/access/users'
    )
  if (/^\/(session|device|new-session)\/[^/]+$/.test(path))
    return `/workspace${path}`
  if (
    consoleModules.some((item) => item.path === path) ||
    /^\/workspace\/(session|device|new-session)\/[^/]+$/.test(path) ||
    path === '/workspace/archived'
  )
    return path
  return null
}
