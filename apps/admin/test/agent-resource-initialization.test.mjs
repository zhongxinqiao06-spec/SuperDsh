import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const source = registerSource()
const { apiClient } = await import('../src/lib/api/index.ts')
const { agentsApi } = await import('../src/features/agents/api.ts')
const {
  ensureAgentResources,
  knowledgeBasesApi,
  agentSkillsApi,
  agentToolsApi,
} = await import('../src/features/agents/resources-api.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
test.after(() => source.deregister())
test.afterEach(() => clearStoredSession())

function login(userId) {
  saveStoredSession({
    userId,
    accessToken: `token-${userId}`,
    roles: ['admin'],
    permissions: ['agents.manage'],
    authzVersion: 1,
  })
}

test('all four lists wait for one persisted initialization request per login', async (t) => {
  login('admin-a')
  let release
  const writes = []
  const reads = []
  t.mock.method(apiClient, 'post', async (path) => {
    writes.push(path)
    await new Promise((resolve) => {
      release = resolve
    })
  })
  t.mock.method(apiClient, 'get', async (path, options) => {
    reads.push({ path, options })
    return { items: [], total: 0, page: 2, pageSize: 25 }
  })
  const requests = [
    agentsApi.list(2, 25, '示例'),
    knowledgeBasesApi.list(2, 25, '示例'),
    agentSkillsApi.list(2, 25, '示例'),
    agentToolsApi.list(2, 25, '示例'),
    agentsApi.catalog(),
  ]
  assert.deepEqual(writes, ['/admin/agents/initialize'])
  assert.equal(reads.length, 0)
  release()
  await Promise.all(requests)
  assert.deepEqual(
    reads.map((item) => item.path).sort(),
    [
      '/admin/agents',
      '/admin/agents/catalog',
      '/admin/knowledge-bases',
      '/admin/skills',
      '/admin/tools',
    ].sort(),
  )
  assert.deepEqual(
    reads.find((item) => item.path === '/admin/skills').options.query,
    { page: 2, pageSize: 25, search: '示例' },
  )
  await ensureAgentResources()
  assert.equal(writes.length, 1)
})

test('failed initialization never reports an empty list and can be retried', async (t) => {
  login('admin-b')
  let attempts = 0
  let reads = 0
  t.mock.method(apiClient, 'post', async () => {
    attempts++
    if (attempts === 1) throw new Error('Database unavailable')
  })
  t.mock.method(apiClient, 'get', async () => {
    reads++
    return { items: [{ id: 'seeded-example' }], total: 1 }
  })
  await assert.rejects(
    knowledgeBasesApi.list(1, 25, ''),
    /Database unavailable/,
  )
  assert.equal(reads, 0)
  const result = await knowledgeBasesApi.list(1, 25, '')
  assert.equal(attempts, 2)
  assert.equal(result.items[0].id, 'seeded-example')
})

test('a new login gets its own initialization; token rotation reuses the current one', async (t) => {
  login('admin-c')
  let attempts = 0
  t.mock.method(apiClient, 'post', async () => {
    attempts++
  })
  await ensureAgentResources()
  login('admin-c')
  await ensureAgentResources()
  assert.equal(attempts, 1)
  clearStoredSession()
  login('admin-c')
  await ensureAgentResources()
  assert.equal(attempts, 2)
  login('admin-d')
  await ensureAgentResources()
  assert.equal(attempts, 3)
})
