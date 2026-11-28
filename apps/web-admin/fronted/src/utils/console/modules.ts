import type {
  ConsoleModule,
  MenuNode,
  Product,
} from '@/types/console/navigation'

/** 产品模块ID沿用冻结目录，业务页面在路由装配时逐一验证。 */
export const consoleModules: readonly ConsoleModule[] = [
  {
    id: 'studio.deliveries',
    path: '/entertainment/deliveries',
    title: '成片交付',
    englishTitle: 'Deliveries',
    icon: 'folder',
    product: 'entertainment',
    permissions: ['studio.projects.read'],
    implemented: true,
  },
  {
    id: 'studio.environments',
    path: '/entertainment/environments',
    title: '场景库',
    englishTitle: 'Environments',
    icon: 'book-open',
    product: 'entertainment',
    permissions: ['studio.assets.read'],
    implemented: true,
  },
  {
    id: 'studio.props',
    path: '/entertainment/props',
    title: '道具库',
    englishTitle: 'Props',
    icon: 'folder',
    product: 'entertainment',
    permissions: ['studio.assets.read'],
    implemented: true,
  },
  {
    id: 'studio.characters',
    path: '/entertainment/characters',
    title: '角色库',
    englishTitle: 'Characters',
    icon: 'users',
    product: 'entertainment',
    permissions: ['studio.assets.read'],
    implemented: true,
  },
  {
    id: 'office.history',
    path: '/workspace/history',
    title: '历史会话',
    englishTitle: 'Conversation history',
    icon: 'history',
    product: 'office',
    permissions: ['sessions.read'],
    implemented: true,
  },
  {
    id: 'office.devices',
    path: '/workspace/devices',
    title: '我的设备',
    englishTitle: 'My devices',
    icon: 'monitor',
    product: 'office',
    permissions: ['devices.read'],
    implemented: true,
  },
  {
    id: 'product.directory',
    path: '/product/directory',
    title: '成员与账号',
    englishTitle: 'Members and accounts',
    icon: 'users',
    productAction: 'members',
    permissions: ['users.read', 'roles.manage'],
    implemented: true,
  },
  {
    id: 'product.members',
    path: '/product/members',
    title: '产品成员',
    englishTitle: 'Product members',
    icon: 'users',
    productAction: 'members',
    permissions: [],
    implemented: true,
  },
  {
    id: 'product.defaults',
    path: '/product/defaults',
    title: '默认模型',
    englishTitle: 'Default models',
    icon: 'key',
    productAction: 'models',
    permissions: [],
    implemented: true,
  },
  {
    id: 'platform.extensions',
    path: '/system/extensions',
    title: '扩展管理',
    englishTitle: 'Extensions',
    icon: 'wrench',
    permissions: ['extensions.manage'],
    implemented: true,
  },
  {
    id: 'studio.create',
    path: '/entertainment',
    title: '首页',
    englishTitle: 'Home',
    icon: 'house',
    product: 'entertainment',
    permissions: ['studio.projects.read'],
    implemented: true,
  },
  {
    id: 'studio.projects',
    path: '/entertainment/works',
    title: '我的作品',
    englishTitle: 'Projects',
    icon: 'folder',
    product: 'entertainment',
    permissions: ['studio.projects.read'],
    implemented: true,
  },
  {
    id: 'studio.library',
    path: '/entertainment/library',
    title: '媒体库',
    englishTitle: 'Asset library',
    icon: 'book-open',
    product: 'entertainment',
    permissions: ['studio.assets.read'],
    implemented: true,
  },
  {
    id: 'studio.tasks',
    path: '/entertainment/tasks',
    title: '制作任务',
    englishTitle: 'Production tasks',
    icon: 'history',
    product: 'entertainment',
    permissions: ['studio.projects.read'],
    implemented: true,
  },
  {
    id: 'overview',
    path: '/overview',
    title: '平台总览',
    englishTitle: 'Overview',
    icon: 'gauge',
    permissions: ['settings.manage'],
    implemented: true,
  },
  {
    id: 'access.users',
    path: '/access/users',
    title: '账号与角色',
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
    productAction: 'menus',
    path: '/access/menus',
    title: '菜单配置',
    englishTitle: 'Navigation menus',
    icon: 'menu',
    permissions: ['menus.read', 'menus.manage'],
    implemented: true,
  },
  {
    id: 'agents',
    productAction: 'resources',
    path: '/agents',
    title: '智能体',
    englishTitle: 'Agents',
    icon: 'bot',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'knowledge',
    productAction: 'resources',
    path: '/knowledge',
    title: '知识库',
    englishTitle: 'Knowledge bases',
    icon: 'book-open',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'skills',
    productAction: 'resources',
    path: '/skills',
    title: '技能',
    englishTitle: 'Skills',
    icon: 'sparkles',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'tools',
    productAction: 'resources',
    path: '/tools',
    title: '工具',
    englishTitle: 'Tools',
    icon: 'wrench',
    permissions: ['agents.manage'],
    implemented: true,
  },
  {
    id: 'models',
    path: '/models',
    title: '供应商与模型',
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
    title: '存储与服务',
    englishTitle: 'File storage',
    icon: 'folder',
    permissions: ['storage.manage'],
    implemented: true,
  },
  {
    id: 'account.files',
    product: 'office',
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
    product: 'office',
    path: '/workspace',
    title: '智能对话',
    englishTitle: 'Agent workspace',
    icon: 'bot',
    permissions: ['sessions.read', 'sessions.run', 'devices.read'],
    implemented: true,
  },
  {
    id: 'system.service',
    path: '/system/service',
    title: '服务设置',
    englishTitle: 'Service configuration',
    icon: 'settings',
    permissions: ['settings.manage'],
    implemented: true,
  },
  {
    id: 'system.audit',
    path: '/system/audit',
    title: '平台审计',
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
    id: 'billing.rates',
    path: '/billing/rates',
    title: '模型扣点价目',
    englishTitle: 'Model rates',
    icon: 'box',
    permissions: ['billing.read'],
    implemented: true,
  },
  {
    id: 'billing.plans',
    path: '/billing/plans',
    title: '套餐版本管理',
    englishTitle: 'Plan versions',
    icon: 'box',
    permissions: ['billing.read'],
    implemented: true,
  },
  {
    id: 'billing.cards',
    path: '/billing/cards',
    title: '额度卡管理',
    englishTitle: 'Credit card management',
    icon: 'box',
    permissions: ['billing.read'],
    implemented: true,
  },
  {
    id: 'billing.subscriptions',
    path: '/billing/subscriptions',
    title: '会员记录与办理',
    englishTitle: 'Membership operations',
    icon: 'gauge',
    permissions: ['billing.read'],
    implemented: true,
  },
  {
    id: 'account.cards',
    path: '/account/cards',
    title: '我的额度卡',
    englishTitle: 'My credit cards',
    icon: 'box',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.membership',
    path: '/account/membership',
    title: '我的会员与额度',
    englishTitle: 'My membership and credits',
    icon: 'gauge',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.plans',
    path: '/account/plans',
    title: '套餐与加购',
    englishTitle: 'Plans and top-ups',
    icon: 'box',
    permissions: [],
    implemented: true,
  },
  {
    id: 'account.security',
    path: '/account/security',
    title: '账号安全',
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
    title: '手机登录记录',
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
  product?: Product,
): boolean {
  if (
    module.product &&
    ((product && product !== module.product) ||
      !permissions.includes('products.' + module.product))
  )
    return false
  if (module.productAction) {
    return (
      module.permissions.some((permission) =>
        permissions.includes(permission),
      ) ||
      Boolean(
        product &&
        permissions.includes('products.' + product) &&
        permissions.includes(
          'products.' + product + '.' + module.productAction + '.manage',
        ),
      )
    )
  }
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
  product?: Product,
): MenuNode[] {
  const allowed = (item: MenuNode) =>
    roles.includes('admin') ||
    (item.visible &&
      (!item.roleIds.length ||
        item.roleIds.some((role) => roles.includes(role))))
  const groups = items.filter((item) => item.kind === 'group' && allowed(item))
  const pages = items.filter((item) => {
    const module = consoleModules.find((value) => value.id === item.moduleId)
    return (
      item.kind === 'page' &&
      allowed(item) &&
      module &&
      canOpenModule(module, permissions, product) &&
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
