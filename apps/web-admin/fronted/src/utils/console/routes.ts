import { canOpenModule, consoleModules } from '@/utils/console/modules'
import { parseQuery } from 'vue-router'
import { workspacePreviewContinuation } from '@/utils/file-preview/preview-location'

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

/** 登录后恢复已登记的站内页面及查询参数（作品阶段或公共菜单上下文）。 */
export function consoleContinuation(
  value: unknown,
  permissions?: readonly string[],
): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[#\\]/u.test(value))
    return null
  const index = value.indexOf('?')
  if (value.slice(0, index) === '/preview' && index > 0)
    return workspacePreviewContinuation(parseQuery(value.slice(index + 1)))
  const path = canonicalPath(
    index < 0 ? value : value.slice(0, index),
    permissions,
  )
  return path ? path + (index < 0 ? '' : value.slice(index)) : null
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
  if (
    ['/products', '/office', '/entertainment'].includes(path) ||
    /^\/entertainment\/[\w-]+$/.test(path) ||
    /^\/entertainment\/(quick|series)\/[\w-]+$/.test(path) ||
    path === '/entertainment/storyboard/new'
  )
    return path
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
