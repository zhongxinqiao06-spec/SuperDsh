import type { Page } from '@playwright/test'
import type {
  MenuNode,
  MenusResponse,
} from '../../fronted/src/types/console/navigation'

type MenuModule = MenusResponse['modules'][number]

function pageItems(modules: MenuModule[]): MenuNode[] {
  return modules.map((module, order) => ({
    id: module.id,
    kind: 'page',
    moduleId: module.id,
    parentId: null,
    title: module.title,
    icon: module.icon,
    order,
    visible: true,
    roleIds: [],
  }))
}

/** 各产品持有独立初始快照；模拟保存和恢复不会跨产品或跨用例修改数据。 */
function menuCatalog(modules: MenuModule[], defaults = pageItems(modules)) {
  return { version: 1, modules, defaults, items: structuredClone(defaults) }
}

/** 合成浏览器契约fixture；不把这些请求替身作为真实后端验收证据。 */
export async function installFoundationFixture(
  page: Page,
  permissions?: string[],
) {
  const allPermissions = [
    'products.office',
    'users.read',
    'users.manage',
    'roles.manage',
    'audit.read',
    'menus.read',
    'menus.manage',
    'devices.manage',
    'sessions.read',
    'sessions.run',
    'models.use',
    'settings.manage',
  ]
  const identity = {
    userId: 'fixture-admin',
    username: 'admin',
    displayName: '合成管理员',
    email: null,
    role: 'admin',
    roles: ['admin'],
    permissions: permissions
      ? permissions.some((value) => value.startsWith('products.'))
        ? permissions
        : [...permissions, 'products.office']
      : allPermissions,
    authzVersion: 1,
    accessToken: 'fixture-token',
    tokenType: 'bearer',
  }
  const users = [
    { ...identity, disabled: false, revision: 1 },
    {
      userId: 'fixture-member',
      username: 'member',
      displayName: '合成成员',
      email: null,
      roles: ['member'],
      role: 'member',
      disabled: false,
      revision: 1,
    },
  ]
  const roles = [
    {
      id: 'admin',
      name: '管理员',
      description: '系统管理员',
      builtin: true,
      permissions: allPermissions,
      revision: 1,
    },
    {
      id: 'member',
      name: '普通成员',
      description: '普通账号',
      builtin: true,
      permissions: ['sessions.read'],
      revision: 1,
    },
  ]
  const officeModules = [
    {
      id: 'overview',
      title: '平台总览',
      route: '#/overview',
      icon: 'gauge',
      permissions: ['settings.manage'],
    },
    {
      id: 'access.users',
      title: '账号与角色',
      route: '#/access/users',
      icon: 'users',
      permissions: ['users.read'],
    },
    {
      id: 'access.roles',
      title: '角色与权限',
      route: '#/access/roles',
      icon: 'shield',
      permissions: ['roles.manage'],
    },
    {
      id: 'access.menus',
      title: '菜单管理',
      route: '#/access/menus',
      icon: 'menu',
      permissions: ['menus.read', 'menus.manage'],
    },
    {
      id: 'workbench',
      title: '智能对话',
      route: '#/workspace',
      icon: 'bot',
      permissions: ['sessions.read'],
    },
  ]
  const studioPages: [string, string, string, string][] = [
    ['studio.create', '首页', '#/entertainment', 'house'],
    ['studio.projects', '作品项目', '#/entertainment/works', 'folder'],
    ['studio.library', '素材库', '#/entertainment/library', 'book-open'],
    ['studio.tasks', '制作任务', '#/entertainment/tasks', 'history'],
  ]
  const studioModules = studioPages.map(([id, title, route, icon]) => ({
    id,
    title,
    route,
    icon,
    permissions: ['products.entertainment'],
  }))
  const entertainmentModules = [
    ...studioModules,
    ...officeModules.filter((item) => item.id !== 'workbench'),
  ]
  const accessGroup: MenuNode = {
    id: 'access',
    kind: 'group',
    moduleId: null,
    parentId: null,
    title: '用户与权限',
    icon: 'users',
    order: studioModules.length,
    visible: true,
    roleIds: [],
  }
  const entertainmentItems = pageItems(entertainmentModules).map((item) =>
    item.id.startsWith('access.')
      ? { ...item, parentId: accessGroup.id }
      : item,
  )
  const menus = {
    office: menuCatalog(officeModules),
    entertainment: menuCatalog(entertainmentModules, [
      accessGroup,
      ...entertainmentItems,
    ]),
  }
  const state = {
    identity,
    signedIn: false,
    get menuVersion() {
      return menus.office.version
    },
    set menuVersion(value) {
      menus.office.version = value
    },
    userConflict: false,
    agentStatus: 'stopped',
    requests: [] as string[],
  }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname.replace(/^\/api/, '')
      state.requests.push(`${request.method()} ${path}`)
      const body: Record<string, unknown> = request.postData()
        ? JSON.parse(request.postData()!)
        : {}
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(value),
        })
      if (path === '/auth/config')
        return json({
          needsBootstrap: false,
          registrationOpen: false,
          oauthEnabled: false,
          emailVerificationRequired: false,
          setupTokenExpiresAt: null,
        })
      if (path === '/auth/password-salt') return json({ salt: 'fixture-salt' })
      if (path === '/auth/login') {
        state.signedIn = true
        return json(identity)
      }
      if (path === '/auth/refresh')
        return state.signedIn ? json(identity) : json({ detail: '未登录' }, 401)
      if (path === '/auth/logout') {
        state.signedIn = false
        return route.fulfill({ status: 204 })
      }
      if (!state.signedIn) return json({ detail: '未登录' }, 401)
      if (path === '/auth/me') return json(identity)
      if (
        path === '/navigation' ||
        path === '/admin/menus' ||
        path === '/admin/menus/reset'
      ) {
        const scope = url.searchParams.get('product') ?? 'office'
        if (scope !== 'office' && scope !== 'entertainment')
          return json({ detail: '产品无效' }, 422)
        const catalog = menus[scope]
        const has = (permission: string) =>
          identity.permissions.includes(permission)
        if (path === '/navigation') {
          if (url.searchParams.has('product') && !has('products.' + scope))
            return json({ detail: '没有产品权限' }, 403)
          const visible = catalog.items.filter(
            (item) =>
              item.visible &&
              (!item.roleIds.length ||
                item.roleIds.some((role) => identity.roles.includes(role))),
          )
          const pages = visible.filter((item) => {
            const module = catalog.modules.find(
              (entry) => entry.id === item.moduleId,
            )
            return (
              module &&
              (!module.permissions.length || module.permissions.some(has)) &&
              (module.id !== 'workbench' || has('products.office')) &&
              (!item.parentId ||
                visible.some(
                  (group) =>
                    group.kind === 'group' && group.id === item.parentId,
                ))
            )
          })
          return json({
            version: catalog.version,
            items: [
              ...visible.filter(
                (item) =>
                  item.kind === 'group' &&
                  pages.some((page) => page.parentId === item.id),
              ),
              ...pages,
            ],
          })
        }
        if (
          !has('menus.manage') &&
          (request.method() !== 'GET' || !has('menus.read'))
        )
          return json({ detail: '没有菜单管理权限' }, 403)
        if (request.method() !== 'GET') {
          if (body.version !== catalog.version)
            return json(
              { detail: '菜单版本冲突，请重新加载', code: 'revision_conflict' },
              409,
            )
          catalog.items = path.endsWith('/reset')
            ? structuredClone(catalog.defaults)
            : (body.items as MenuNode[])
          catalog.version++
        }
        return json({
          version: catalog.version,
          items: catalog.items,
          modules: catalog.modules,
          roles,
          icons: [
            'gauge',
            'users',
            'shield',
            'menu',
            'bot',
            'folder',
            'book-open',
            'history',
          ],
        })
      }
      if (
        [
          '/studio/projects',
          '/studio/works',
          '/studio/library',
          '/studio/jobs',
        ].includes(path) &&
        request.method() === 'GET'
      ) {
        if (!identity.permissions.includes('products.entertainment'))
          return json({ detail: '没有娱乐权限' }, 403)
        if (path === '/studio/projects' && !url.searchParams.has('page'))
          return json([])
        return json({
          items: [],
          total: 0,
          page: Number(url.searchParams.get('page') || 1),
          pageSize: Number(url.searchParams.get('pageSize') || 10),
        })
      }
      if (/^\/studio\/projects\/[^/]+\/preparation$/u.test(path))
        return json({ revision: 1, stages: [] })
      if (/^\/studio\/projects\/[^/]+\/episode-context$/u.test(path))
        return json(null)
      if (path === '/me/billing/registration-card-notice') return json(null)
      if (path === '/announcement') return json({ announcement: null })
      if (path === '/admin/users' && request.method() === 'GET')
        return json({ users, total: users.length, page: 1, pageSize: 25 })
      if (path === '/admin/users' && request.method() === 'POST') {
        const user = {
          userId: `user-${users.length}`,
          username: String(body.username),
          displayName: String(body.displayName),
          email: null,
          roles: ['member'],
          role: 'member',
          disabled: false,
          revision: 1,
        }
        users.push(user)
        return json(user)
      }
      if (path.startsWith('/admin/users/') && request.method() === 'PATCH') {
        if (state.userConflict)
          return json(
            { detail: '用户已被修改，请重新加载', code: 'revision_conflict' },
            409,
          )
        const user = users.find((entry) => path.endsWith(entry.userId))
        if (!user) return json({ detail: '不存在' }, 404)
        Object.assign(user, body)
        return json(user)
      }
      if (path === '/admin/roles')
        return json({
          roles,
          permissions: allPermissions.map((id) => ({ id, label: id })),
        })
      if (path === '/server-agent') {
        if (request.method() === 'POST') state.agentStatus = 'running'
        return json({
          agent: {
            status: state.agentStatus,
            connectorId: 'connector',
            runtimeId: 'dsh',
            projectId: 'managed-project',
            error: null,
          },
        })
      }
      if (path === '/connectors')
        return json({
          connectors: [
            {
              id: 'connector',
              name: '合成服务端 Agent',
              executorKind: 'server-agent',
              status: state.agentStatus === 'running' ? 'online' : 'offline',
            },
          ],
        })
      if (path === '/projects')
        return json({
          projects: [
            {
              id: 'managed-project',
              connectorId: 'connector',
              name: '受管工作区',
              workspacePath: '/synthetic',
              pinned: false,
              activeSessionCount: 0,
            },
          ],
        })
      if (path === '/sessions/list' || path === '/sessions')
        return json({ sessions: [], nextCursor: null })
      if (path === '/agents')
        return json({ items: [], total: 0, page: 1, pageSize: 100 })
      if (path.endsWith('/catalogs/model')) return json({ models: [] })
      if (path.endsWith('/catalogs/permission'))
        return json({ permissions: [] })
      return json({ detail: `fixture未实现 ${path}` }, 404)
    },
  )
  return state
}
