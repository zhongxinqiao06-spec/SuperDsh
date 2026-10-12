import {
  createElement,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
} from 'react'

export type ConsoleModule = {
  id: string
  route: string
  title: string
  englishTitle: string
  icon: string
  permissions: readonly string[]
  component: LazyExoticComponent<ComponentType>
}

const account = (
  section: 'profile' | 'security' | 'models' | 'appearance' | 'mobile',
) =>
  lazy(async () => {
    const { AccountPage } = await import('@/components/console/account-page')
    return { default: () => createElement(AccountPage, { section }) }
  })

export const consoleModules: readonly ConsoleModule[] = [
  {
    id: 'overview',
    route: '#/overview',
    title: '总览',
    englishTitle: 'Overview',
    icon: 'gauge',
    permissions: [],
    component: lazy(() =>
      import('@/components/console/overview-page').then((m) => ({
        default: m.OverviewPage,
      })),
    ),
  },
  {
    id: 'access.users',
    route: '#/access/users',
    title: '用户管理',
    englishTitle: 'Users',
    icon: 'users',
    permissions: ['users.read'],
    component: lazy(() =>
      import('@/components/management/users-panel').then((m) => ({
        default: m.UsersPanel,
      })),
    ),
  },
  {
    id: 'access.roles',
    route: '#/access/roles',
    title: '角色与权限',
    englishTitle: 'Roles and permissions',
    icon: 'shield',
    permissions: ['roles.manage'],
    component: lazy(() =>
      import('@/components/management/roles-panel').then((m) => ({
        default: m.RolesPanel,
      })),
    ),
  },
  {
    id: 'access.menus',
    route: '#/access/menus',
    title: '菜单管理',
    englishTitle: 'Navigation menus',
    icon: 'menu',
    permissions: ['menus.read', 'menus.manage'],
    component: lazy(() =>
      import('@/components/console/menus-page').then((m) => ({
        default: m.MenusPage,
      })),
    ),
  },
  {
    id: 'models',
    route: '#/models',
    title: '模型管理',
    englishTitle: 'Platform models',
    icon: 'key',
    permissions: ['models.manage'],
    component: lazy(() =>
      import('@/components/management/models-panel').then((m) => ({
        default: m.ModelsPanel,
      })),
    ),
  },
  {
    id: 'devices',
    route: '#/operations/devices',
    title: '设备运维',
    englishTitle: 'Device operations',
    icon: 'monitor',
    permissions: ['devices.inventory.read'],
    component: lazy(() =>
      import('@/components/management/devices-panel').then((m) => ({
        default: m.DevicesPanel,
      })),
    ),
  },
  {
    id: 'workbench',
    route: '#/workspace',
    title: 'Agent 工作台',
    englishTitle: 'Agent workspace',
    icon: 'bot',
    permissions: ['sessions.read', 'sessions.run', 'devices.read'],
    component: lazy(() =>
      import('@/components/demo').then((m) => ({ default: m.Demo })),
    ),
  },
  {
    id: 'system.service',
    route: '#/system/service',
    title: '服务配置',
    englishTitle: 'Service configuration',
    icon: 'settings',
    permissions: ['settings.manage'],
    component: lazy(() =>
      import('@/components/pages/service-page').then((m) => ({
        default: m.ServicePage,
      })),
    ),
  },
  {
    id: 'system.audit',
    route: '#/system/audit',
    title: '审计日志',
    englishTitle: 'Audit log',
    icon: 'history',
    permissions: ['audit.read'],
    component: lazy(() =>
      import('@/components/management/audit-panel').then((m) => ({
        default: m.AuditPanel,
      })),
    ),
  },
  {
    id: 'account.profile',
    route: '#/account/profile',
    title: '账号资料',
    englishTitle: 'Account profile',
    icon: 'user',
    permissions: [],
    component: account('profile'),
  },
  {
    id: 'account.security',
    route: '#/account/security',
    title: '账号安全与登录记录',
    englishTitle: 'Security and sign-ins',
    icon: 'shield',
    permissions: [],
    component: account('security'),
  },
  {
    id: 'account.models',
    route: '#/account/models',
    title: '个人模型',
    englishTitle: 'Personal models',
    icon: 'key',
    permissions: ['models.personal.manage'],
    component: account('models'),
  },
  {
    id: 'account.appearance',
    route: '#/account/appearance',
    title: '外观设置',
    englishTitle: 'Appearance',
    icon: 'paintbrush',
    permissions: [],
    component: account('appearance'),
  },
  {
    id: 'account.mobile',
    route: '#/account/mobile',
    title: '手机登录会话',
    englishTitle: 'Mobile sign-ins',
    icon: 'smartphone',
    permissions: [],
    component: account('mobile'),
  },
]

export function canOpenModule(
  module: ConsoleModule,
  permissions: readonly string[] = [],
) {
  return (
    !module.permissions.length ||
    module.permissions.some((permission) => permissions.includes(permission))
  )
}
