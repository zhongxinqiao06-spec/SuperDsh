import {
  ApiError,
  ApiRouter,
  integer,
  object,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import { IdentityService, json, type Row } from '../identity/service.ts'

export const icons = [
  'gauge',
  'users',
  'shield',
  'menu',
  'bot',
  'key',
  'monitor',
  'settings',
  'user',
  'history',
  'paintbrush',
  'smartphone',
  'folder',
  'book-open',
  'sparkles',
  'wrench',
]
export const modules = [
  ['overview', '#/overview', '总览', 'gauge', []],
  ['access.users', '#/access/users', '用户管理', 'users', ['users.read']],
  ['access.roles', '#/access/roles', '角色与权限', 'shield', ['roles.manage']],
  [
    'access.menus',
    '#/access/menus',
    '菜单管理',
    'menu',
    ['menus.read', 'menus.manage'],
  ],
  ['models', '#/models', '模型管理', 'key', ['models.manage']],
  ['agents', '#/agents', '智能体列表', 'bot', ['agents.manage']],
  ['knowledge', '#/knowledge', '知识库', 'book-open', ['agents.manage']],
  ['skills', '#/skills', '技能管理', 'sparkles', ['agents.manage']],
  ['tools', '#/tools', '工具管理', 'wrench', ['agents.manage']],
  [
    'devices',
    '#/operations/devices',
    '设备运维',
    'monitor',
    ['devices.inventory.read'],
  ],
  [
    'workbench',
    '#/workspace',
    'Agent 工作台',
    'bot',
    ['sessions.read', 'sessions.run', 'devices.read'],
  ],
  [
    'system.service',
    '#/system/service',
    '服务设置',
    'settings',
    ['settings.manage'],
  ],
  ['system.audit', '#/system/audit', '审计', 'history', ['audit.read']],
  ['account.profile', '#/account/profile', '账号资料', 'user', []],
  [
    'account.security',
    '#/account/security',
    '账号安全与登录记录',
    'shield',
    [],
  ],
  [
    'account.models',
    '#/account/models',
    '个人模型',
    'key',
    ['models.personal.manage'],
  ],
  ['account.appearance', '#/account/appearance', '外观设置', 'paintbrush', []],
  ['account.mobile', '#/account/mobile', '手机登录记录', 'smartphone', []],
].map(([id, route, title, icon, permissions]) => ({
  id: id as string,
  route: route as string,
  title: title as string,
  icon: icon as string,
  permissions: permissions as string[],
}))
export interface MenuNode {
  id: string
  kind: 'group' | 'page'
  moduleId: string | null
  parentId: string | null
  title: string
  icon: string
  order: number
  visible: boolean
  roleIds: string[]
}
export const agentMenuGroupId = 'agent-management'
const agentPageIds = ['agents', 'knowledge', 'skills', 'tools']

export function defaultMenuItems(): MenuNode[] {
  const groups = [
    ['access', '用户与权限', 'users', 1],
    [agentMenuGroupId, '智能体管理', 'bot', 2],
    ['system', '系统管理', 'settings', 6],
    ['account', '个人中心', 'user', 7],
  ] as const
  const items: MenuNode[] = groups.map(([id, title, icon, order]) => ({
    id,
    kind: 'group',
    moduleId: null,
    parentId: null,
    title,
    icon,
    order,
    visible: true,
    roleIds: [],
  }))
  const rootOrder: Record<string, number> = {
      overview: 0,
      models: 3,
      devices: 4,
      workbench: 5,
    },
    childOrder: Record<string, number> = {}
  for (const module of modules) {
    const parentId = agentPageIds.includes(module.id)
      ? agentMenuGroupId
      : module.id.includes('.')
        ? module.id.split('.')[0]!
        : null
    const order = parentId ? childOrder[parentId] || 0 : rootOrder[module.id]!
    if (parentId) childOrder[parentId] = order + 1
    items.push({
      id: module.id,
      kind: 'page',
      moduleId: module.id,
      parentId,
      title: module.title,
      icon: module.icon,
      order,
      visible: true,
      roleIds: [],
    })
  }
  return items
}

/** One-time layout migration preserves each page's visibility and role restrictions. */
export function groupAgentMenuItems(items: MenuNode[]): MenuNode[] {
  const defaults = defaultMenuItems()
  const existingGroup = items.find((item) => item.id === agentMenuGroupId)
  if (existingGroup && existingGroup.kind !== 'group')
    throw new Error('Agent menu group conflicts with an existing page')
  const result = [...items]
  if (!existingGroup) {
    const oldEntry = items.find((item) => item.id === 'agents')
    result.push({
      ...defaults.find((item) => item.id === agentMenuGroupId)!,
      order: oldEntry?.parentId === null ? oldEntry.order : 2,
    })
  }
  for (const id of agentPageIds)
    if (!result.some((item) => item.id === id))
      result.push(defaults.find((item) => item.id === id)!)
  return result.map((item) =>
    agentPageIds.includes(item.id)
      ? {
          ...item,
          parentId: agentMenuGroupId,
          order: agentPageIds.indexOf(item.id),
          title:
            item.id === 'agents' && item.title === '智能体管理'
              ? '智能体列表'
              : item.title,
        }
      : item,
  )
}
function moduleAllowed(id: string, permissions: string[]): boolean {
  const module = modules.find((item) => item.id === id)
  return (
    !!module &&
    (!module.permissions.length ||
      module.permissions.some((permission) => permissions.includes(permission)))
  )
}
export function validateMenuItems(value: unknown, roles: string[]): MenuNode[] {
  if (!Array.isArray(value) || value.length > 128)
    throw new ApiError(422, 'invalid menu collection')
  const items = value.map((entry) => {
    const row = object(entry)
    if (
      Object.keys(row).some(
        (key) =>
          ![
            'id',
            'kind',
            'moduleId',
            'parentId',
            'title',
            'icon',
            'order',
            'visible',
            'roleIds',
          ].includes(key),
      )
    )
      throw new ApiError(422, 'unknown menu field')
    if (
      !/^[a-z][a-z0-9._-]{0,63}$/.test(text(row.id)) ||
      !['group', 'page'].includes(text(row.kind)) ||
      text(row.title).trim() !== row.title ||
      !text(row.title) ||
      text(row.title).length > 64 ||
      !icons.includes(text(row.icon)) ||
      typeof row.order !== 'number' ||
      typeof row.visible !== 'boolean' ||
      !Array.isArray(row.roleIds) ||
      row.roleIds.length > 100 ||
      row.roleIds.some((id) => typeof id !== 'string' || !roles.includes(id)) ||
      new Set(row.roleIds).size !== row.roleIds.length
    )
      throw new ApiError(422, 'invalid menu node, icon or role')
    integer(row.order, 0, 0, 10000)
    if (
      (row.moduleId !== null && typeof row.moduleId !== 'string') ||
      (row.parentId !== null && typeof row.parentId !== 'string')
    )
      throw new ApiError(422, 'invalid menu parent or module')
    return row as unknown as MenuNode
  })
  const byId = new Map(items.map((item) => [item.id, item]))
  if (byId.size !== items.length)
    throw new ApiError(422, 'menu node ids must be unique')
  const pages = new Set<string>()
  for (const item of items) {
    if (item.kind === 'group') {
      if (
        item.moduleId !== null ||
        item.parentId !== null ||
        modules.some((module) => module.id === item.id)
      )
        throw new ApiError(422, 'groups must be root nodes without a module')
    } else {
      if (
        !modules.some((module) => module.id === item.moduleId) ||
        item.id !== item.moduleId
      )
        throw new ApiError(422, 'page id must match its registered module')
      if (item.parentId !== null && byId.get(item.parentId)?.kind !== 'group')
        throw new ApiError(422, 'page parent must be a root group')
      pages.add(item.id)
    }
  }
  if (pages.size !== modules.length)
    throw new ApiError(422, 'registered pages cannot be added or removed')
  return items
}
export function visibleMenuItems(items: MenuNode[], user: Account): MenuNode[] {
  const shown = (item: MenuNode) =>
    item.visible &&
    (!item.roleIds.length ||
      item.roleIds.some((role) => user.roles.includes(role)))
  const groups = items.filter((item) => item.kind === 'group' && shown(item)),
    groupIds = new Set(groups.map((item) => item.id))
  const pages = items.filter(
    (item) =>
      item.kind === 'page' &&
      shown(item) &&
      moduleAllowed(
        item.moduleId!,
        user.resetRequired ? [] : user.permissions,
      ) &&
      (!item.parentId || groupIds.has(item.parentId)),
  )
  const parents = new Set(pages.map((item) => item.parentId))
  return [...pages, ...groups.filter((item) => parents.has(item.id))].sort(
    (a, b) =>
      (a.parentId || '').localeCompare(b.parentId || '') ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  )
}
export function assertMenuEditAllowed(
  previous: MenuNode[],
  next: MenuNode[],
  permissions: string[],
): void {
  const old = new Map(previous.map((item) => [item.id, item])),
    current = new Map(next.map((item) => [item.id, item]))
  const changed = new Set(
    [...old.keys(), ...current.keys()].filter(
      (id) => JSON.stringify(old.get(id)) !== JSON.stringify(current.get(id)),
    ),
  )
  for (const item of [...previous, ...next])
    if (
      item.kind === 'page' &&
      (changed.has(item.id) || (item.parentId && changed.has(item.parentId))) &&
      !moduleAllowed(item.moduleId!, permissions)
    )
      throw new ApiError(403, 'cannot configure a page above your authority')
}
export function registerNavigationRoutes(
  router: ApiRouter,
  identity: IdentityService,
): void {
  const db = identity.db
  async function configuration() {
    const [row] = await db.query<Row>(
      "SELECT version,items_json FROM navigation_settings WHERE id='global'",
    )
    return {
      version: Number(row?.version || 1),
      items: json<MenuNode[]>(row?.items_json, defaultMenuItems()),
    }
  }
  async function catalog(config?: { version: number; items: MenuNode[] }) {
    return {
      ...(config || (await configuration())),
      modules,
      icons,
      roles: await db.query('SELECT id,name FROM roles ORDER BY id'),
    }
  }
  router.add('GET', '/navigation', async (context) => {
    const config = await configuration()
    return {
      version: config.version,
      items: visibleMenuItems(config.items, await context.user()),
    }
  })
  router.add('GET', '/admin/menus', async (context) => {
    const user = await context.user()
    if (
      user.resetRequired ||
      !user.permissions.some((permission) =>
        ['menus.read', 'menus.manage'].includes(permission),
      )
    )
      throw new ApiError(403, 'menu read permission required')
    return catalog()
  })
  for (const reset of [false, true])
    router.add(
      reset ? 'POST' : 'PUT',
      reset ? '/admin/menus/reset' : '/admin/menus',
      async (context) => {
        const actor = await context.user('menus.manage'),
          version = integer(context.body.version, 0, 1),
          items = reset ? defaultMenuItems() : context.body.items
        const config = await db.transaction(async (connection) => {
          await connection.query('SELECT pg_advisory_xact_lock(4141455)')
          await identity.currentActor(actor, connection, 'menus.manage')
          await connection.query(
            "INSERT INTO navigation_settings(id,version,items_json,updated_at) VALUES('global',1,$1,$2) ON CONFLICT DO NOTHING",
            [JSON.stringify(defaultMenuItems()), utcNow()],
          )
          const [previous] = await connection.query<Row>(
            "SELECT * FROM navigation_settings WHERE id='global' FOR UPDATE",
          )
          if (Number(previous?.version) !== version)
            throw new ApiError(
              409,
              'menu configuration changed; reload before saving',
            )
          const roles = await connection.query<{ id: string }>(
            'SELECT id FROM roles',
          )
          const validated = validateMenuItems(
            items,
            roles.map((role) => role.id),
          )
          assertMenuEditAllowed(
            json<MenuNode[]>(previous?.items_json, []),
            validated,
            actor.permissions,
          )
          await connection.query(
            "UPDATE navigation_settings SET version=$1,items_json=$2,updated_by=$3,updated_at=$4 WHERE id='global'",
            [version + 1, JSON.stringify(validated), actor.userId, utcNow()],
          )
          await identity.audit(
            actor.userId,
            reset ? 'menu.reset' : 'menu.updated',
            'global',
            { previousVersion: version, version: version + 1 },
            connection,
          )
          return { version: version + 1, items: validated }
        })
        return catalog(config)
      },
      { permission: 'menus.manage' },
    )
}
