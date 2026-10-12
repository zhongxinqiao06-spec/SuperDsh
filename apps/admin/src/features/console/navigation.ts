import { canOpenModule, consoleModules } from './modules'
import type { MenuNode } from './types'

export function visibleNavigation(
  items: MenuNode[],
  permissions: readonly string[],
  roles: readonly string[],
) {
  const allowed = (item: MenuNode) =>
    item.visible &&
    (!item.roleIds.length || item.roleIds.some((role) => roles.includes(role)))
  const groups = items.filter((item) => item.kind === 'group' && allowed(item))
  const pages = items.filter((item) => {
    if (item.kind !== 'page' || !allowed(item)) return false
    const module = consoleModules.find((module) => module.id === item.moduleId)
    return (
      module &&
      canOpenModule(module, permissions) &&
      (!item.parentId || groups.some((group) => group.id === item.parentId))
    )
  })
  return [
    ...groups.filter((group) =>
      pages.some((page) => page.parentId === group.id),
    ),
    ...pages,
  ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}
