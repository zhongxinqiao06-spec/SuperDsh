import { createServer } from 'node:http'
import {
  loadLegacy,
  type LegacyAccount,
  type LegacyApi,
  type LegacyRouter,
} from './legacy-boundary.ts'

const { ApiError, ApiRouter } =
  await loadLegacy<LegacyApi>('http/api-router.ts')
const { registerAccountManagementRoutes } = await loadLegacy<{
  registerAccountManagementRoutes(router: LegacyRouter, identity: unknown): void
}>('management/accounts.ts')
const { permissions } = await loadLegacy<{
  permissions: Record<string, string>
}>('identity/permissions.ts')
const { validateProvider } = await loadLegacy<{
  validateProvider(value: unknown): Record<string, unknown>
}>('models/model-service.ts')
const { validateModelParameters, modelCapabilities } = await loadLegacy<{
  validateModelParameters(
    adapter: string,
    capability: string,
    model: string,
    values: unknown,
  ): Record<string, unknown>
  modelCapabilities: Record<string, unknown>[]
}>('models/capabilities.ts')

type Row = Record<string, unknown>
interface RoleCase {
  id: string
  method: string
  route: string
  body?: Row
  grants?: string[]
  assigned?: boolean
}
const account: LegacyAccount = {
  userId: 'synthetic-admin',
  username: 'synthetic',
  email: null,
  emailVerified: false,
  displayName: 'Synthetic',
  role: 'admin',
  roles: ['admin'],
  permissions: Object.keys(permissions),
  authzVersion: 1,
  resetRequired: false,
  disabled: false,
  deletedAt: null,
}
const roleFixtures: Row[] = [
  {
    id: 'admin',
    name: 'Admin',
    description: '',
    builtin: 1,
    permissions_json: JSON.stringify(Object.keys(permissions)),
  },
  {
    id: 'member',
    name: 'Member',
    description: '',
    builtin: 1,
    permissions_json: JSON.stringify(['sessions.read']),
  },
  {
    id: 'custom',
    name: 'Custom',
    description: '',
    builtin: 0,
    permissions_json: '[]',
  },
  {
    id: 'protected',
    name: 'Protected',
    description: '',
    builtin: 0,
    permissions_json: JSON.stringify(['users.manage']),
  },
]
let currentCase: RoleCase
let actor = account
let roles = structuredClone(roleFixtures)
const db = {
  async query(sql: string, values: unknown[] = []): Promise<Row[]> {
    if (sql.startsWith('SELECT pg_advisory')) return []
    if (sql === 'SELECT * FROM roles ORDER BY id')
      return [...roles].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    if (sql.startsWith('INSERT INTO roles')) {
      roles.push({
        id: values[0],
        name: values[1],
        description: values[2],
        builtin: 0,
        permissions_json: values[3],
      })
      return []
    }
    if (sql.startsWith('UPDATE roles')) {
      Object.assign(
        roles.find((role) => role.id === values[0])!,
        {
          name: values[1],
          description: values[2],
          permissions_json: values[3],
        },
      )
      return []
    }
    if (sql.startsWith('UPDATE users SET auth_version')) return []
    if (sql.startsWith('SELECT user_id FROM user_roles'))
      return currentCase.assigned ? [{ user_id: 'assigned-user' }] : []
    if (sql.startsWith('DELETE FROM roles')) {
      roles = roles.filter((role) => role.id !== values[0])
      return []
    }
    throw new Error(`Unimplemented isolated oracle query: ${sql}`)
  },
  async transaction<T>(
    operation: (connection: unknown) => Promise<T>,
  ): Promise<T> {
    return operation(db)
  },
}
const identity = {
  db,
  options: {},
  currentActor: async () => actor,
  audit: async () => undefined,
}
const router = new ApiRouter(async (_request, permission) => {
  if (permission && !actor.permissions.includes(permission))
    throw new ApiError(403, `permission required: ${permission}`)
  return actor
})
registerAccountManagementRoutes(router, identity)
const cases: RoleCase[] = [
  { id: 'roles-list', method: 'GET', route: '/admin/roles' },
  { id: 'roles-read-denied', method: 'GET', route: '/admin/roles', grants: [] },
  {
    id: 'role-create',
    method: 'POST',
    route: '/admin/roles',
    body: {
      name: 'Reader',
      description: 'Synthetic',
      permissions: ['users.read'],
    },
  },
  {
    id: 'role-create-normalized',
    method: 'POST',
    route: '/admin/roles',
    body: {
      name: ' Reader ',
      permissions: ['users.read', 'sessions.read', 'users.read'],
    },
  },
  {
    id: 'role-create-empty-name',
    method: 'POST',
    route: '/admin/roles',
    body: { name: '  ', permissions: [] },
  },
  {
    id: 'role-create-long-name',
    method: 'POST',
    route: '/admin/roles',
    body: { name: 'x'.repeat(65), permissions: [] },
  },
  {
    id: 'role-create-long-description',
    method: 'POST',
    route: '/admin/roles',
    body: { name: 'Role', description: 'x'.repeat(501), permissions: [] },
  },
  {
    id: 'role-create-unknown-grant',
    method: 'POST',
    route: '/admin/roles',
    body: { name: 'Role', permissions: ['unknown.permission'] },
  },
  {
    id: 'role-create-above-authority',
    method: 'POST',
    route: '/admin/roles',
    grants: ['roles.manage'],
    body: { name: 'Role', permissions: ['users.manage'] },
  },
  {
    id: 'role-update',
    method: 'PATCH',
    route: '/admin/roles/custom',
    body: { name: 'Edited', permissions: ['users.read'] },
  },
  {
    id: 'role-update-missing',
    method: 'PATCH',
    route: '/admin/roles/missing',
    body: { name: 'Edited', permissions: [] },
  },
  {
    id: 'role-update-builtin',
    method: 'PATCH',
    route: '/admin/roles/admin',
    body: { name: 'Edited', permissions: [] },
  },
  {
    id: 'role-update-protected',
    method: 'PATCH',
    route: '/admin/roles/protected',
    grants: ['roles.manage'],
    body: { name: 'Edited', permissions: [] },
  },
  { id: 'role-delete', method: 'DELETE', route: '/admin/roles/custom' },
  {
    id: 'role-delete-missing',
    method: 'DELETE',
    route: '/admin/roles/missing',
  },
  { id: 'role-delete-builtin', method: 'DELETE', route: '/admin/roles/admin' },
  {
    id: 'role-delete-assigned',
    method: 'DELETE',
    route: '/admin/roles/custom',
    assigned: true,
  },
  {
    id: 'role-delete-protected',
    method: 'DELETE',
    route: '/admin/roles/protected',
    grants: ['roles.manage'],
  },
]
const server = createServer((request, response) => {
  void router.handle(request, response, {
    signal: new AbortController().signal,
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string')
  throw new Error('Missing HTTP oracle address')
const management: Row[] = []
try {
  for (const entry of cases) {
    currentCase = entry
    actor = { ...account, permissions: entry.grants ?? account.permissions }
    roles = structuredClone(roleFixtures)
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v2${entry.route}`,
      {
        method: entry.method,
        headers: { 'content-type': 'application/json' },
        ...(entry.body ? { body: JSON.stringify(entry.body) } : {}),
      },
    )
    const text = await response.text()
    management.push({
      input: entry,
      status: response.status,
      body: text ? (JSON.parse(text) as unknown) : null,
    })
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
const provider: Row = {
  name: 'Synthetic',
  protocol: 'openai-completions',
  baseUrl: 'https://models.invalid/',
  models: [{ modelId: 'synthetic-chat', name: 'Synthetic' }],
}
const providerCases = [
  { id: 'provider-defaults', input: provider },
  { id: 'provider-no-key', input: { ...provider, apiKey: '' } },
  { id: 'provider-clear-key', input: { ...provider, clearApiKey: true } },
  {
    id: 'provider-replace-clear-conflict',
    input: { ...provider, apiKey: 'synthetic-only', clearApiKey: true },
  },
  {
    id: 'provider-credential-url',
    input: { ...provider, baseUrl: 'https://user:pass@models.invalid' },
  },
  {
    id: 'provider-query-url',
    input: { ...provider, baseUrl: 'https://models.invalid?token=synthetic' },
  },
  {
    id: 'provider-fragment-url',
    input: { ...provider, baseUrl: 'https://models.invalid#invalid' },
  },
  {
    id: 'provider-protocol-invalid',
    input: { ...provider, protocol: 'unsupported' },
  },
  { id: 'provider-empty-models', input: { ...provider, models: [] } },
  {
    id: 'provider-duplicate-models',
    input: { ...provider, models: [provider.models, provider.models].flat() },
  },
  { id: 'provider-enabled-string', input: { ...provider, enabled: 'false' } },
  {
    id: 'provider-unknown-field',
    input: { ...provider, credential: 'unsafe' },
  },
  ...[0, -1, 1.5, '8192', true, null, 8192].map((limit, index) => ({
    id: `provider-token-boundary-${index}`,
    input: {
      ...provider,
      models: [
        { modelId: 'synthetic-chat', name: 'Synthetic', maxTokens: limit },
      ],
    },
  })),
]
const providers = providerCases.map((input) => {
  try {
    return { input, status: 200, value: validateProvider(input.input) }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { input, status: error.status }
  }
})
const parameterInputs = [
  ...[
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'volcengine-ark',
    'volcengine-speech',
  ].flatMap((adapter) =>
    ['chat', 'vision.analyze', 'image.generate', 'embedding'].map(
      (capability) => ({ adapter, capability, model: 'synthetic', values: {} }),
    ),
  ),
  ...['seedream-4', 'seedream-5', 'unknown-endpoint'].flatMap((model) =>
    [
      '1K',
      '1.5K',
      '2K',
      '4K',
      '1024x1024',
      '2048x2048',
      '20000x300',
      'invalid',
    ].map((size) => ({
      adapter: 'volcengine-ark',
      capability: 'image.generate',
      model,
      values: { size },
    })),
  ),
  ...[-1, 0, 1, 131072, 131073, 1.5].map((maxTokens) => ({
    adapter: 'openai-completions',
    capability: 'chat',
    model: 'synthetic',
    values: { maxTokens },
  })),
  ...['provider-default', 'disabled', 'enabled', 'invalid'].flatMap(
    (thinking) =>
      ['openai-completions', 'volcengine-ark'].map((adapter) => ({
        adapter,
        capability: 'vision.analyze',
        model: 'synthetic',
        values: { thinking },
      })),
  ),
]
const parameters = parameterInputs.map((input, index) => {
  try {
    return {
      id: `model-parameter-${index}`,
      input,
      status: 200,
      value: validateModelParameters(
        input.adapter,
        input.capability,
        input.model,
        input.values,
      ),
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { id: `model-parameter-${index}`, input, status: error.status }
  }
})
process.stdout.write(
  JSON.stringify({
    management,
    roleFixtures,
    permissions,
    providers,
    parameters,
    modelCapabilities,
  }),
)
