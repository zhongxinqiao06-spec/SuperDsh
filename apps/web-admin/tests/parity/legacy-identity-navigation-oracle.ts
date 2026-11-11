import { createServer } from 'node:http'
import {
  loadLegacy,
  type LegacyAccount,
  type LegacyApi,
  type LegacyIdentityRoutes,
  type LegacyNavigation,
} from './legacy-boundary.ts'

const { ApiError, ApiRouter } =
  await loadLegacy<LegacyApi>('http/api-router.ts')
const { registerIdentityRoutes } =
  await loadLegacy<LegacyIdentityRoutes>('identity/routes.ts')
const {
  assertMenuEditAllowed,
  defaultMenuItems,
  icons,
  modules,
  validateMenuItems,
  visibleMenuItems,
} = await loadLegacy<LegacyNavigation>('management/navigation.ts')

/** 直接执行旧包处理器；仅身份存储端口替换为合成数据，不启动旧平台或执行引擎。 */
const user: LegacyAccount = {
  userId: 'synthetic-user',
  username: 'synthetic',
  email: null,
  emailVerified: false,
  displayName: 'Synthetic',
  role: 'member',
  roles: ['member'],
  permissions: [],
  authzVersion: 1,
  resetRequired: false,
  disabled: false,
  deletedAt: null,
}
const fixtureOrigin = 'http://parity.invalid'
process.env.AGENT_SERVER_PUBLIC_ORIGIN = fixtureOrigin
process.env.AGENT_SERVER_CORS_ORIGINS = 'http://allowed.invalid'
let revoked: string[] = []
const { IdentityService } = await loadLegacy<{
  IdentityService: new (
    db: unknown,
    options: Record<string, unknown>,
  ) => {
    crypto: { userAccessClaims(token: string): unknown }
  }
}>('identity/service.ts')
const realIdentity = new IdentityService(
  { query: async () => [{ count: '0' }] },
  {
    secret: 'synthetic-parity-signing-key-at-least-32-chars',
    setupToken: 'synthetic-setup',
    setupTokenExpiresAt: '2030-01-01T00:00:00Z',
  },
)
realIdentity.crypto.userAccessClaims = (token) =>
  token === 'valid-access' ? { sid: 'session-b' } : null
const identity = Object.assign(realIdentity, {
  authenticateToken: async (token: string) =>
    token === 'valid-access' ? user : null,
  refreshLogin: async (token: string) =>
    token === 'session-a.refresh'
      ? {
          user,
          accessToken: 'synthetic-access',
          refreshToken: 'session-a.next',
        }
      : null,
  revokeLogin: async (input: {
    refresh?: string
    userId?: string
    sessionId?: string
  }) => {
    if (input.refresh === 'session-a.refresh') revoked.push('session-a')
    if (input.userId === user.userId && input.sessionId === 'session-b')
      revoked.push('session-b')
  },
  prepare: () => undefined,
})
const router = new ApiRouter(async (request) => {
  if (request.headers.authorization !== 'Bearer valid-access')
    throw new ApiError(401, 'login session expired or revoked')
  return user
})
registerIdentityRoutes(router, identity)

interface AuthCase {
  id: string
  route: string
  cookie?: string
  origin?: string
  access?: string
  method?: string
  emptyBody?: boolean
  body?: Record<string, unknown>
}
const authCases: AuthCase[] = [
  { id: 'password-salt-missing-identifier', route: '/auth/password-salt' },
  { id: 'login-missing-identifier', route: '/auth/login' },
  { id: 'registration-missing-bootstrap-token', route: '/auth/register' },
  { id: 'recovery-missing-identifier', route: '/auth/recovery/reset' },
  { id: 'recovery-email-missing-address', route: '/auth/recovery/reset-email' },
  { id: 'email-code-missing-address', route: '/auth/email-code' },
  { id: 'oauth-token-missing-grant', route: '/oauth/token' },
  { id: 'oauth-finalize-missing-token', route: '/auth/oauth/finalize' },
  ...['request', 'status', 'confirm', 'exchange'].map((operation) => ({
    id: `mobile-${operation}-missing-token`,
    route: `/auth/mobile-login/${operation}`,
  })),
  {
    id: 'refresh-cookie-no-origin',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
  },
  {
    id: 'refresh-cookie-empty-body',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
    emptyBody: true,
  },
  {
    id: 'refresh-cookie-same-origin',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
    origin: fixtureOrigin,
  },
  {
    id: 'refresh-cookie-allowed-origin',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
    origin: 'http://allowed.invalid',
  },
  {
    id: 'refresh-cookie-untrusted-origin',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
    origin: 'http://untrusted.invalid',
  },
  {
    id: 'refresh-cookie-null-origin',
    route: '/auth/refresh',
    cookie: 'session-a.refresh',
    origin: 'null',
  },
  {
    id: 'refresh-cookie-expired',
    route: '/auth/refresh',
    cookie: 'expired.refresh',
    origin: fixtureOrigin,
  },
  {
    id: 'refresh-no-credentials',
    route: '/auth/refresh',
    origin: fixtureOrigin,
    emptyBody: true,
  },
  {
    id: 'refresh-native',
    route: '/auth/refresh',
    body: { refreshToken: 'session-a.refresh' },
    origin: 'http://untrusted.invalid',
  },
  {
    id: 'refresh-native-expired',
    route: '/auth/refresh',
    body: { refreshToken: 'expired.refresh' },
  },
  {
    id: 'refresh-android-client-payload',
    route: '/auth/refresh',
    body: { refreshToken: 'session-a.refresh', clientName: 'SuperDsh Android' },
    origin: 'http://untrusted.invalid',
  },
  {
    id: 'refresh-desktop-client-payload',
    route: '/auth/refresh',
    body: { refreshToken: 'session-a.refresh', clientName: 'SuperDsh Desktop' },
    origin: 'http://untrusted.invalid',
  },
  {
    id: 'logout-cookie-no-origin',
    route: '/auth/logout',
    cookie: 'session-a.refresh',
  },
  {
    id: 'logout-cookie-empty-body',
    route: '/auth/logout',
    cookie: 'session-a.refresh',
    emptyBody: true,
  },
  {
    id: 'logout-both-sessions',
    route: '/auth/logout',
    cookie: 'session-a.refresh',
    access: 'valid-access',
  },
  {
    id: 'logout-invalid-refresh-valid-access',
    route: '/auth/logout',
    cookie: 'expired.refresh',
    access: 'valid-access',
  },
  {
    id: 'logout-native-both-sessions',
    route: '/auth/logout',
    body: { refreshToken: 'session-a.refresh' },
    access: 'valid-access',
    origin: 'http://untrusted.invalid',
  },
  {
    id: 'logout-cookie-untrusted-origin',
    route: '/auth/logout',
    cookie: 'session-a.refresh',
    access: 'valid-access',
    origin: 'http://untrusted.invalid',
  },
  { id: 'logout-empty', route: '/auth/logout', emptyBody: true },
]
const server = createServer((request, response) => {
  void router.handle(request, response, {
    signal: new AbortController().signal,
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string')
  throw new Error('Missing oracle HTTP address')
const authResults: Record<string, unknown>[] = []
try {
  for (const entry of authCases) {
    revoked = []
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (entry.origin) headers.origin = entry.origin
    if (entry.cookie) headers.cookie = `superdsh_refresh=${entry.cookie}`
    if (entry.access) headers.authorization = `Bearer ${entry.access}`
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v2${entry.route}`,
      {
        method: 'POST',
        headers,
        ...(entry.emptyBody ? {} : { body: JSON.stringify(entry.body || {}) }),
      },
    )
    const body = await response.text()
    authResults.push({
      input: entry,
      status: response.status,
      body: body ? (JSON.parse(body) as unknown) : null,
      cookie: response.headers.get('set-cookie'),
      revoked: [...new Set(revoked)].sort(),
    })
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

/** 用真实目录生成逐权限场景，避免以新代码重新实现旧预期。 */
const defaults = defaultMenuItems()
const allPermissions = [
  ...new Set(modules.flatMap((module) => module.permissions)),
]
const visibility = [
  [],
  allPermissions,
  ...allPermissions.map((permission) => [permission]),
].flatMap((permissions) =>
  [false, true].map((resetRequired) => ({
    permissions,
    resetRequired,
    items: visibleMenuItems(defaults, { ...user, permissions, resetRequired }),
  })),
)
const mutations: {
  id: string
  field: string
  value?: unknown
  remove?: boolean
}[] = [
  { id: 'group-id-uppercase', field: 'id', value: 'INVALID' },
  { id: 'group-id-leading-digit', field: 'id', value: '1invalid' },
  { id: 'group-id-too-long', field: 'id', value: 'a'.repeat(65) },
  { id: 'title-leading-space', field: 'title', value: ' 标题' },
  { id: 'title-trailing-space', field: 'title', value: '标题 ' },
  { id: 'title-too-long', field: 'title', value: '中'.repeat(65) },
  { id: 'title-empty', field: 'title', value: '' },
  { id: 'order-negative', field: 'order', value: -1 },
  { id: 'order-too-large', field: 'order', value: 10001 },
  { id: 'order-boolean', field: 'order', value: true },
  { id: 'order-fractional', field: 'order', value: 1.5 },
  { id: 'parent-missing', field: 'parentId', remove: true },
  { id: 'module-missing', field: 'moduleId', remove: true },
  { id: 'roles-duplicate', field: 'roleIds', value: ['member', 'member'] },
  { id: 'unknown-field', field: 'unsafe', value: true },
  { id: 'title-valid-limit', field: 'title', value: '中'.repeat(64) },
  { id: 'order-valid-limit', field: 'order', value: 10000 },
]
const validation = mutations.map((input) => {
  const items = structuredClone(defaults) as unknown as Record<
    string,
    unknown
  >[]
  if (input.remove) delete items[0]![input.field]
  else items[0]![input.field] = input.value
  try {
    validateMenuItems(items, ['admin', 'member'])
    return { input, items, status: 200 }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { input, items, status: error.status }
  }
})
const editChecks = [
  ['menus.manage'],
  ['menus.manage', 'users.read'],
  allPermissions,
].flatMap((permissions) =>
  ['access.menus', 'workbench', 'access.users'].map((id) => {
    const items = structuredClone(defaults)
    items.find((item) => item.id === id)!.title = '修改标题'
    let status = 200
    try {
      assertMenuEditAllowed(defaults, items, permissions)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      status = error.status
    }
    return { id, permissions, items, status }
  }),
)
process.stdout.write(
  JSON.stringify({
    auth: authResults,
    modules,
    icons,
    defaults,
    visibility,
    validation,
    editChecks,
  }),
)
