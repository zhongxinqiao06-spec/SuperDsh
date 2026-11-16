import type { ComputedRef, InjectionKey } from 'vue'
import type { MenuNode } from '@/types/console/navigation'

/** 首页快捷入口复用当前侧栏过滤后的菜单，管理员调整角色范围时两处同步。 */
export const consoleMenuKey: InjectionKey<ComputedRef<MenuNode[]>> =
  Symbol('console-menus')
