import type { Page } from '@playwright/test'

/** 合成浏览器契约fixture；不把这些请求替身作为真实后端验收证据。 */
export async function installFoundationFixture(
  page: Page,
  permissions?: string[],
) {
  const allPermissions = [
    'users.read',
    'users.manage',
    'roles.manage',
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
    permissions: permissions ?? allPermissions,
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
  const modules = [
    {
      id: 'overview',
      title: '总览',
      route: '#/overview',
      icon: 'gauge',
      permissions: [],
    },
    {
      id: 'access.users',
      title: '用户管理',
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
      permissions: ['menus.read'],
    },
    {
      id: 'workbench',
      title: 'Agent 工作台',
      route: '#/workspace',
      icon: 'bot',
      permissions: ['sessions.read'],
    },
  ]
  let items = modules.map((module, order) => ({
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
  const state = {
    signedIn: false,
    menuVersion: 1,
    userConflict: false,
    agentStatus: 'stopped',
    requests: [] as string[],
  }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname.replace(/^\/api/, '')
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
      if (path === '/navigation')
        return json({ version: state.menuVersion, items })
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
      if (path === '/admin/menus' && request.method() === 'GET')
        return json({
          version: state.menuVersion,
          items,
          modules,
          roles,
          icons: ['gauge', 'users', 'shield', 'menu', 'bot', 'folder'],
        })
      if (path === '/admin/menus' && request.method() === 'PUT') {
        if (body.version !== state.menuVersion)
          return json(
            { detail: '菜单版本冲突，请重新加载', code: 'revision_conflict' },
            409,
          )
        items = body.items as typeof items
        state.menuVersion++
        return json({
          version: state.menuVersion,
          items,
          modules,
          roles,
          icons: ['folder'],
        })
      }
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
