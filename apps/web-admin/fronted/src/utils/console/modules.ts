import type { ConsoleModule, MenuNode } from '@/types/console/navigation'

/** 产品模块ID沿用冻结目录，业务页面在路由装配时逐一验证。 */
export const consoleModules: readonly ConsoleModule[] = [
  {
    id: 'overview',
    path: '/overview',
    title: '总览',
    englishTitle: 'Overview',
    icon: 'gauge',
    permissions: [],
    implemented: true,
  },
  {
    id: 'access.users',
    path: '/access/users',
    title: '用户管理',
    englishTitle: 'Users',
    icon: 'users',
    permissions: ['users.read'],
    implemented: true,
  },
  {
    id: 'access.roles',
    path: '/access/roles',
    title: '角色与权限',
    englishTitle: 'Roles and permissions',
    icon: 'shield',
    permissions: ['roles.manage'],
    implemented: true,
  },
  {
    id: 'access.menus',
    path: '/access/menus',
    title: '菜单管理',
    englishTitle: 'Navigation menus',
    icon: 'menu',
    permissions: ['menus.read', 'menus.manage'],
    implemented: true,
  },
  {
    id: 'agents',
    path: '/agents',
    title: '智能体列表',
    englishTitle: 'Agents',
    icon: 'bot',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'knowledge',
    path: '/knowledge',
    title: '知识库',
    englishTitle: 'Knowledge bases',
    icon: 'book-open',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'skills',
    path: '/skills',
    title: '技能管理',
    englishTitle: 'Skills',
    icon: 'sparkles',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'tools',
    path: '/tools',
    title: '工具管理',
    englishTitle: 'Tools',
    icon: 'wrench',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'models',
    path: '/models',
    title: '聊天模型',
    englishTitle: 'Platform models',
    icon: 'key',
    permissions: ['models.manage'],
    implemented: true,
  },
  {
    id: 'models.multimodal',
    path: '/models/multimodal',
    title: '多模态模型',
    englishTitle: 'Multimodal models',
    icon: 'sparkles',
    permissions: ['models.manage'],
    implemented: true,
  },
  {
    id: 'system.storage',
    path: '/system/storage',
    title: '文件存储',
    englishTitle: 'File storage',
    icon: 'folder',
    permissions: ['storage.manage'],
    implemented: true,
  },
  {
    id: 'account.files',
    path: '/account/files',
    title: '我的文件',
    englishTitle: 'My files',
    icon: 'folder',
    permissions: ['files.read'],
    implemented: true,
  },
  {
    id: 'devices',
    path: '/operations/devices',
    title: '设备运维',
    englishTitle: 'Device operations',
    icon: 'monitor',
    permissions: ['devices.inventory.read'],
    implemented: true,
  },
  {
    id: 'workbench',
    path: '/workspace',
    title: 'Agent 工作台',
    englishTitle: 'Agent workspace',
    icon: 'bot',
    permissions: ['sessions.read', 'sessions.run', 'devices.read'],
    implemented: true,
  },
  {
    id: 'system.service',
    path: '/system/service',
    title: '服务配置',
    englishTitle: 'Service configuration',
    icon: 'settings',
    permissions: ['settings.manage'],
    implemented: true,
  },
  {
    id: 'system.audit',
    path: '/system/audit',
    title: '审计日志',
    englishTitle: 'Audit log',
    icon: 'history',
    permissions: ['audit.read'],
    implemented: true,
  },
  {
    id: 'account.profile',
    path: '/account/profile',
    title: '账号资料',
    englishTitle: 'Account profile',
    icon: 'user',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.security',
    path: '/account/security',
    title: '账号安全与登录记录',
    englishTitle: 'Security and sign-ins',
    icon: 'shield',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.models',
    path: '/account/models',
    title: '个人模型',
    englishTitle: 'Personal models',
    icon: 'key',
    permissions: ['models.personal.manage'],
    implemented: true,
  },
  {
    id: 'account.appearance',
    path: '/account/appearance',
    title: '外观设置',
    englishTitle: 'Appearance',
    icon: 'paintbrush',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.mobile',
    path: '/account/mobile',
    title: '手机登录会话',
    englishTitle: 'Mobile sign-ins',
    icon: 'smartphone',
    permissions: [],
    implemented: true,
  },
]

/** 模块以任一列出的权限开放；具体写操作仍由服务端逐项授权。 */
export function canOpenModule(
  module: ConsoleModule,
  permissions: readonly string[],
): boolean {
  return (
    module.permissions.length === 0 ||
    module.permissions.some((item) => permissions.includes(item))
  )
}

/** 过滤菜单展示，不拿菜单是否可见作为路由授权条件。 */
export function visibleNavigation(
  items: MenuNode[],
  permissions: readonly string[],
  roles: readonly string[],
): MenuNode[] {
  const allowed = (item: MenuNode) =>
    item.visible &&
    (!item.roleIds.length || item.roleIds.some((role) => roles.includes(role)))
  const groups = items.filter((item) => item.kind === 'group' && allowed(item))
  const pages = items.filter((item) => {
    const module = consoleModules.find((value) => value.id === item.moduleId)
    return (
      item.kind === 'page' &&
      allowed(item) &&
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
