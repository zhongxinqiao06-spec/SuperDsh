import type { MenuNode } from '@/types/console/navigation'

/** 在已授权的菜单上置顶首页。旧分组仍参与权限过滤，角色预览与实际侧栏共用此顺序。 */
export function homeFirst(items: MenuNode[]): MenuNode[] {
  const home = items.find((item) => item.moduleId === 'studio.create')
  if (!home) return items
  const siblings = items.filter((item) => item !== home)
  return [
    {
      ...home,
      parentId: null,
      title: home.title === '创作中心' ? '首页' : home.title,
      icon:
        home.title === '创作中心' && home.icon === 'sparkles'
          ? 'house'
          : home.icon,
    },
    ...siblings.filter(
      (item) =>
        item.id !== home.parentId ||
        siblings.some((child) => child.parentId === item.id),
    ),
  ]
}

/** 只翻译原始默认名称，自定义名称保持用户配置。 */
export const navigationGroups: Readonly<
  Record<string, readonly [string, string]>
> = {
  'office-workspace': ['办公工作台', 'Office workspace'],
  'studio-workspace': ['创作工作台', 'Creative workspace'],
  capabilities: ['能力管理', 'Capabilities'],
  'product-management': ['产品管理', 'Product management'],
  platform: ['平台管理', 'Platform management'],
  access: ['用户与权限', 'Users and access'],
  'agent-management': ['智能体管理', 'Agent management'],
  'model-management': ['模型管理', 'Model management'],
  system: ['系统管理', 'System management'],
  account: ['个人中心', 'Account'],
}

/** 旧深链仍打开原视图，目录默认优先进入当前产品。 */
export const memberDirectoryTabs = [
  ['product.members', '本产品成员', 'Product members'],
  ['access.users', '全部账号', 'All accounts'],
  ['access.roles', '角色与权限', 'Roles and permissions'],
] as const

/** 旧配置若给两个入口设置了不同权限，先按授权过滤，再折叠可见项。 */
export function memberDirectoryItems(items: MenuNode[]): MenuNode[] {
  const legacy = memberDirectoryTabs.flatMap(([id]) =>
    items.filter((i) => i.moduleId === id),
  )
  if (!legacy.length) return items
  const anchor =
    items.find((i) => i.moduleId === 'product.directory') ?? legacy[0]!
  const result = items
    .filter((i) => !legacy.includes(i) || i === anchor)
    .map((i) =>
      i === anchor && legacy.includes(i) ? { ...i, title: '成员与账号' } : i,
    )
  return result.filter(
    (i) =>
      i.kind !== 'group' || result.some((child) => child.parentId === i.id),
  )
}

/** 平台子页沿用旧链接；侧栏只保留一个二级入口，页内切换相关设置。 */
export const consoleTabGroups: ReadonlyArray<
  ReadonlyArray<readonly [string, string, string]>
> = [
  memberDirectoryTabs,
  [
    ['models', '聊天配置', 'Chat models'],
    ['models.multimodal', '多模态配置', 'Multimodal models'],
  ],
  [
    ['system.storage', '文件存储', 'File storage'],
    ['system.service', '服务设置', 'Service settings'],
  ],
  [
    ['account.membership', '我的会员与额度', 'My membership and credits'],
    ['account.plans', '套餐与加购', 'Plans and top-ups'],
  ],
  [
    ['account.security', '账号安全', 'Account security'],
    ['account.mobile', '手机登录记录', 'Mobile sign-ins'],
  ],
]
