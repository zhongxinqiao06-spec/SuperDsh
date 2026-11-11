import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { consoleModules } from '../../fronted/src/utils/console/modules.ts'

/** 旧 React 与新 Vue 使用相同合成传输；这只证明浏览器行为，不替代真实服务验收。 */
export async function installParityFixture(
  page: Page,
  options: {
    signedIn?: boolean
    permissions?: string[]
    state?: 'normal' | 'error' | 'loading'
  } = {},
) {
  const permissionCatalog = JSON.parse(
    readFileSync(
      new URL('../fixtures/baselines/permissions.json', import.meta.url),
      'utf8',
    ),
  ) as { permissions: Record<string, string> }
  const permissions =
    options.permissions ?? Object.keys(permissionCatalog.permissions)
  const identity = {
    userId: 'parity-admin',
    username: 'admin',
    displayName: '合成管理员',
    email: null,
    role: 'admin',
    roles: ['admin'],
    disabled: false,
    permissions,
    authzVersion: 1,
    accessToken: 'synthetic-access-token',
    tokenType: 'bearer',
  }
  const state = {
    signedIn: options.signedIn ?? true,
    requests: [] as string[],
    missing: [] as string[],
    takeover: true,
  }
  const roles = [
    {
      id: 'admin',
      name: '管理员',
      description: '管理全部功能',
      builtin: true,
      permissions,
      revision: 1,
    },
    {
      id: 'member',
      name: '普通成员',
      description: '使用工作台',
      builtin: true,
      permissions: ['sessions.read'],
      revision: 1,
    },
  ]
  const items = consoleModules.map((module, order) => ({
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
  const paging = { items: [], total: 0, page: 1, pageSize: 20 }
  const dashboardSettings = {
    intensity: { basis: 'messages', lightMax: 10, mediumMax: 50 },
    histogramBins: { messages: [0, 10, 50], sessions: [0, 5, 20] },
  }
  const profile = {
    id: 'synthetic-embedding',
    kind: 'local',
    model: 'fixture',
    dimensions: 32,
    revision: 'fixture',
  }
  const session = () => ({
    id: 'parity-session',
    connectorId: 'parity-device',
    connectorStatus: 'online',
    projectId: null,
    runtimeId: 'dsh',
    runtime: 'dsh',
    title: '合成会话',
    cwd: '/synthetic',
    status: 'idle',
    pinned: false,
    archived: false,
    takeover: state.takeover,
    unread: false,
    updatedSeq: 0,
    agentDefinition: null,
  })
  const catalog: Record<string, unknown> = {
    '/auth/me': identity,
    '/navigation': { version: 1, items },
    '/admin/menus': {
      version: 1,
      items,
      modules: consoleModules.map((module) => ({
        ...module,
        route: `#${module.path}`,
      })),
      icons: consoleModules.map((module) => module.icon),
      roles,
    },
    '/admin/users': {
      users: [{ ...identity, revision: 1 }],
      total: 1,
      page: 1,
      pageSize: 10,
    },
    '/admin/roles': {
      roles,
      permissions: Object.entries(permissionCatalog.permissions).map(
        ([id, label]) => ({ id, label }),
      ),
    },
    '/admin/agents': paging,
    '/admin/agents/initialize': { agents: [], assets: [] },
    '/agents': paging,
    '/models/catalog': { providers: [], default: null },
    '/admin/skills': paging,
    '/admin/tools': paging,
    '/admin/knowledge-bases': paging,
    '/admin/knowledge-bases/search-status': {
      engine: 'qdrant',
      ready: true,
      message: '索引服务正常',
    },
    '/admin/knowledge-embedding': {
      version: 1,
      profile,
      localDefault: profile,
    },
    '/admin/agents/catalog': {
      assets: [],
      knowledgeBases: [],
      skills: [],
      tools: [],
    },
    '/admin/extensions': { items: [] },
    '/admin/models/configurations': {
      configurations: [],
      connections: [],
      capabilities: [
        {
          id: 'chat',
          name: '聊天',
          available: true,
          configurationSchema: { properties: {} },
        },
        {
          id: 'image.generate',
          name: '图像生成',
          available: true,
          configurationSchema: { properties: {} },
        },
      ],
      defaults: [],
    },
    '/models/capabilities': { configurations: [] },
    '/admin/models/providers': { providers: [] },
    '/models/personal/providers': { providers: [] },
    '/admin/models/default': { selection: null },
    '/models/personal/default': { selection: null },
    '/admin/storage': {
      activeConnectionId: 'local',
      revision: 1,
      policy: { maxFileBytes: 104857600, temporaryHours: 24, recycleDays: 30 },
      connections: [
        {
          id: 'local',
          name: '本地存储',
          backend: 'local',
          configuration: { backend: 'local' },
          credentialConfigured: false,
          revision: 1,
          enabled: true,
        },
      ],
    },
    '/admin/storage/usage': { items: [], files: 0, bytes: 0 },
    '/admin/storage/migrations': { items: [], records: [] },
    '/files': paging,
    '/admin/devices': { devices: [], total: 0, page: 1, pageSize: 20 },
    '/admin/audit': { events: [], total: 0, page: 1, pageSize: 20 },
    '/auth/sessions': { sessions: [], total: 0, page: 1, pageSize: 20 },
    '/admin/settings': {
      registrationOpen: false,
      oauthRegistrationOpen: false,
      revision: 1,
      oauth: { enabled: false },
      email: { enabled: false, fromAddress: '', apiKeyConfigured: false },
    },
    '/admin/service': {
      endpoint: 'https://synthetic.invalid',
      version: 'fixture',
      database: 'postgresql',
      databasePath: 'synthetic',
      coordination: 'redis',
      instanceId: 'synthetic',
      startedAt: '2026-11-01T00:00:00.000Z',
      uptimeSeconds: 3600,
    },
    '/admin/announcement': {
      enabled: false,
      markdown: '',
      publishedAt: null,
      revision: 1,
    },
    '/announcement': {
      enabled: false,
      markdown: '',
      publishedAt: null,
      revision: 1,
    },
    '/admin/dashboard/settings': dashboardSettings,
    '/admin/dashboard/overview': {
      summary: { users: 1, sessions: 0, messages: 0, devices: 0 },
      series: [],
      messageHistogram: [],
      sessionHistogram: [],
      userSegments: [],
      deviceBreakdown: [],
      agentBreakdown: [],
      sessionAgentBreakdown: [],
      settings: dashboardSettings,
    },
    '/connectors': {
      connectors: [
        {
          id: 'parity-device',
          name: '合成设备',
          executorKind: 'server-agent',
          status: 'online',
          userId: identity.userId,
          deviceOs: 'linux',
          runtimes: [],
        },
      ],
    },
    '/projects': {
      projects: [
        {
          id: 'parity-project',
          userId: identity.userId,
          connectorId: 'parity-device',
          name: '合成工作区',
          workspacePath: '/synthetic',
          pinned: false,
          activeSessionCount: 0,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    },
    '/sessions/list': { sessions: [], nextCursor: null },
    '/sessions': { sessions: [], nextCursor: null },
    '/server-agent': {
      agent: {
        status: 'running',
        connectorId: 'parity-device',
        runtimeId: 'dsh',
        projectId: 'parity-project',
        error: null,
      },
    },
    '/ws-ticket': { ticket: 'synthetic-ticket' },
    '/auth/mobile-login/qr': {
      userId: identity.userId,
      loginToken: 'synthetic-login-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      serverTime: '2026-11-01T00:00:00.000Z',
    },
    '/auth/mobile-login/status': {
      status: 'pending_scan',
      userId: identity.userId,
      deviceName: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      serverTime: '2026-11-01T00:00:00.000Z',
    },
  }
  const runtime = {
    connectorId: 'parity-device',
    runtimeId: 'dsh',
    runtimeType: 'dsh',
    name: 'DSH',
    displayName: 'DSH',
    present: true,
    available: true,
    configured: true,
    active: true,
    status: 'running',
    discovery: {},
    metadata: {},
    schema: null,
    uiSchema: {},
    config: {},
    error: null,
    lastDiscoveredAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
  // 旧目录从 WS 快照读，新目录从 REST 读；两条传输必须呈现同一份合成事实。
  await page.routeWebSocket(/\/api\/(?:v2\/)?dashboard\/ws/, (socket) => {
    if (options.state === 'error') {
      socket.close({ code: 1011, reason: 'synthetic dependency unavailable' })
      return
    }
    const payload = {
      type: 'dashboard.snapshot',
      connectors: (catalog['/connectors'] as { connectors: unknown[] })
        .connectors,
      projects: (catalog['/projects'] as { projects: unknown[] }).projects,
      sessions: [],
      runtimes: [runtime],
      sessionPages: {
        active: { hasMore: false, nextCursor: null },
        archived: { hasMore: false, nextCursor: null },
      },
      serverTime: '2026-11-01T00:00:00.000Z',
    }
    if (options.state === 'loading') {
      const timer = setTimeout(() => socket.send(JSON.stringify(payload)), 2500)
      socket.onClose(() => clearTimeout(timer))
    } else socket.send(JSON.stringify(payload))
  })
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        method = request.method()
      // 这里只适配旧传输入口；生产兼容仍以声明式路由表为唯一来源。
      const path = new URL(request.url()).pathname.replace(
        /^\/api(?:\/v2)?/,
        '',
      )
      state.requests.push(`${method} ${path}`)
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
      if (path === '/auth/config')
        return json({
          needsBootstrap: false,
          registrationOpen: true,
          oauthRegistrationOpen: false,
          oauthEnabled: false,
        })
      if (path === '/auth/password-salt')
        return json({ salt: 'synthetic-salt' })
      if (path === '/auth/login') {
        state.signedIn = true
        return json(identity)
      }
      if (path === '/auth/refresh')
        return state.signedIn
          ? json(identity)
          : json({ detail: '登录已失效' }, 401)
      if (path === '/auth/logout') {
        state.signedIn = false
        return route.fulfill({ status: 204 })
      }
      if (path === '/announcement') return json(catalog[path])
      if (!state.signedIn) return json({ detail: '请登录' }, 401)
      if (
        !path.startsWith('/auth/') &&
        path !== '/navigation' &&
        options.state === 'error'
      )
        return json(
          { detail: '合成依赖暂时不可用', code: 'synthetic_unavailable' },
          503,
        )
      if (
        !path.startsWith('/auth/') &&
        path !== '/navigation' &&
        options.state === 'loading'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
      if (path.endsWith('/takeover')) {
        state.takeover = method === 'POST'
        return json({ session: session() })
      }
      if (path.endsWith('/snapshot'))
        return json({
          session: session(),
          state: {},
          timeline: { items: [], nextSeq: null, hasMore: false },
          notices: [],
          approvals: [],
          effectiveCapabilities: {},
          eventCursor: '',
        })
      if (path.endsWith('/meta')) return json({ session: session() })
      if (path.endsWith('/agent-binding'))
        return json({ agentDefinition: null, bindingVersion: 0 })
      if (path.endsWith('/events'))
        return json({ events: [], hasMore: false, nextCursor: '' })
      if (path.endsWith('/catalogs/model')) return json({ models: [] })
      if (path.endsWith('/fs/list'))
        return json({
          result: {
            root: '/synthetic',
            path: '',
            entries: [],
            truncated: false,
          },
          ok: true,
          serverTime: '2026-11-01T00:00:00.000Z',
        })
      if (path.endsWith('/capabilities'))
        return json({
          capabilities: {},
          effective: {},
          serverTime: '2026-11-01T00:00:00.000Z',
        })
      if (path.endsWith('/runtimes'))
        return json({ connectorId: 'parity-device', runtimes: [runtime] })
      if (path.endsWith('/runtime-types'))
        return json({ connectorId: 'parity-device', runtimeTypes: [] })
      if (path.endsWith('/catalogs/permission'))
        return json({ permissions: [] })
      if (path.match(/\/(agent-artifacts|skill-runs|plans|shares)$/))
        return json({ items: [] })
      if (path.endsWith('/selections') || path.endsWith('/sync'))
        return json({ ok: true })
      // 读模型不能伪装成写入成功；仅声明确有用途的合成写入口。
      if (
        path in catalog &&
        (method === 'GET' ||
          (method === 'POST' &&
            ['/admin/agents/initialize', '/auth/mobile-login/qr'].includes(
              path,
            )))
      )
        return json(catalog[path])
      state.missing.push(`${method} ${path}`)
      return json({ detail: `合成 fixture 未登记 ${path}` }, 404)
    },
  )
  return state
}
