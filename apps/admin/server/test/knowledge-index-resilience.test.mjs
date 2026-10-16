import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { ApiRouter } from '../http/api-router.ts'
import { IdentityService } from '../identity/service.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { QdrantKnowledgeIndex } from '../agents/knowledge-index.ts'
import { registerKnowledgeIndexRoutes } from '../agents/knowledge-routes.ts'
import { withTestDatabase } from './support/database.mjs'

async function endpoint(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  )
  return `http://127.0.0.1:${server.address().port}`
}

async function relay(request, response) {
  const configured = process.env.SUPERDSH_NODE_TEST_QDRANT_URL
  assert.ok(
    configured,
    'Use the disposable PostgreSQL/Redis/Qdrant test runner',
  )
  assert.equal(new URL(configured).hostname, '127.0.0.1')
  const chunks = []
  for await (const part of request) chunks.push(part)
  const body = Buffer.concat(chunks)
  const result = await fetch(`${configured}${request.url}`, {
    method: request.method,
    headers: { 'content-type': 'application/json' },
    body: body.length ? body : undefined,
    signal: AbortSignal.timeout(10000),
  })
  response.writeHead(result.status, { 'content-type': 'application/json' })
  response.end(Buffer.from(await result.arrayBuffer()))
}

const source = (content) => ({
  id: randomUUID(),
  name: 'Synthetic company policy.md',
  sha256: createHash('sha256').update(content).digest('hex'),
  extracted_text: content,
})

test('knowledge index API reports outages, retains PostgreSQL originals, recovers and preserves owner checks', async (t) => {
  const db = await withTestDatabase(t)
  let online = false
  const proxy = await endpoint(t, (request, response) => {
    if (online) return relay(request, response)
    response.writeHead(503)
    response.end('Synthetic unavailable index')
  })
  const index = new QdrantKnowledgeIndex(proxy)
  const identity = new IdentityService(db, {
    secret: 'synthetic-knowledge-recovery',
  })
  await identity.seedBuiltinRoles()
  const manager = await identity.createUser(
    {
      username: 'manager',
      displayName: 'Synthetic manager',
      password: 'synthetic-manager-password',
    },
    { role: 'admin' },
  )
  const other = await identity.createUser(
    {
      username: 'other-manager',
      displayName: 'Other manager',
      password: 'synthetic-other-password',
    },
    { role: 'admin' },
  )
  const member = await identity.createUser({
    username: 'member',
    displayName: 'Member',
    password: 'synthetic-member-password',
  })
  const tokens = new Map()
  for (const account of [manager, other, member])
    tokens.set(
      account.userId,
      (await identity.issueLogin(account.userId)).accessToken,
    )
  const options = {
    db,
    knowledgeIndex: index,
    audit: identity.audit.bind(identity),
  }
  const business = new BusinessAgentService(options)
  const resources = new AgentResourceService(options)
  const bytes = Buffer.from(
    '报销制度：员工必须提供发票与经理审批，财务复核之后支付。',
  )
  const asset = await business.upload(manager, {
    name: 'synthetic-policy.md',
    kind: 'knowledge',
    contentBase64: bytes.toString('base64'),
  })
  const base = await resources.saveKnowledge(manager, {
    name: 'Company policy',
    description: 'Synthetic data',
    enabled: true,
    assetIds: [asset.id],
  })
  const router = new ApiRouter(identity.authorize)
  registerKnowledgeIndexRoutes(router, business)
  const api = await endpoint(t, (request, response) =>
    router.handle(request, response, { signal: AbortSignal.timeout(15000) }),
  )
  const request = async (path, method = 'GET', account = manager) => {
    const result = await fetch(`${api}/api/v2/admin/knowledge-bases${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokens.get(account.userId)}`,
        'Content-Type': 'application/json',
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    return { status: result.status, body: await result.json() }
  }
  assert.equal((await request('/search-status')).body.ready, false)
  const failed = await request(`/${base.id}/index`, 'POST')
  assert.equal(failed.status, 503)
  assert.match(failed.body.detail, /Qdrant/)
  const [retained] = await db.query(
    'SELECT content,sha256,extracted_text FROM business_agent_assets WHERE id=$1',
    [asset.id],
  )
  assert.deepEqual(retained.content, bytes)
  assert.equal(retained.sha256, asset.sha256)
  assert.match(retained.extracted_text, /财务复核/)
  online = true
  assert.equal((await request('/search-status')).body.ready, true)
  const rebuilt = await request(`/${base.id}/index`, 'POST')
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body))
  assert.deepEqual(rebuilt.body, { indexedAssets: 1, chunks: 1 })
  assert.equal((await request(`/${base.id}/index`, 'POST', other)).status, 404)
  assert.equal((await request(`/${base.id}/index`, 'POST', member)).status, 403)
  online = false
  assert.equal((await request(`/${base.id}/index`, 'POST')).status, 503)
  online = true
  assert.equal((await request(`/${base.id}/index`, 'POST')).status, 200)
  const rows = await db.query(
    'SELECT id,name,sha256,extracted_text FROM business_agent_assets WHERE id=$1',
    [asset.id],
  )
  const found = await index.search(
    manager.userId,
    rows,
    '报销制度',
    2,
    AbortSignal.timeout(10000),
  )
  assert.equal(found[0].assetId, asset.id)
  assert.match(found[0].content, /财务复核/)
  const [audits] = await db.query(
    "SELECT COUNT(*) AS count FROM identity_audit WHERE action='knowledge.index' AND target_id=$1",
    [base.id],
  )
  assert.equal(audits.count, '2')
})

test('cancelling the first query does not cancel collection preparation for a second owner', async (t) => {
  let opened, release
  const received = new Promise((done) => {
    opened = done
  })
  const gate = new Promise((done) => {
    release = done
  })
  let preparations = 0
  const proxy = await endpoint(t, async (request, response) => {
    if (
      request.method === 'GET' &&
      request.url === '/collections/superdsh_knowledge_sparse_v1'
    ) {
      preparations++
      opened()
      await gate
    }
    await relay(request, response)
  })
  const index = new QdrantKnowledgeIndex(proxy)
  const owner = randomUUID()
  const other = randomUUID()
  const ownRow = source('差旅报销需要保留凭证。')
  const otherRow = source('库存管理要求每月清点。')
  const cancellation = new AbortController()
  const first = assert.rejects(
    index.index(owner, [ownRow], cancellation.signal),
    /abort/i,
  )
  await received
  const second = index.index(other, [otherRow], AbortSignal.timeout(10000))
  try {
    cancellation.abort()
    await first
  } finally {
    release()
  }
  assert.deepEqual(await second, { indexedAssets: 1, chunks: 1 })
  assert.equal(preparations, 1)
  const found = await index.search(
    other,
    [otherRow],
    '库存',
    2,
    AbortSignal.timeout(10000),
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].assetId, otherRow.id)
  assert.doesNotMatch(found[0].content, /差旅/)
})

test('Qdrant redirects do not forward the API key and empty searches need no index connection', async (t) => {
  let destinationRequests = 0
  let indexRequests = 0
  const destination = await endpoint(t, (_request, response) => {
    destinationRequests++
    response.end('{}')
  })
  const redirect = await endpoint(t, (_request, response) => {
    indexRequests++
    response.writeHead(302, { location: `${destination}/collect` })
    response.end()
  })
  const index = new QdrantKnowledgeIndex(
    redirect,
    'synthetic-private-index-key',
  )
  assert.equal((await index.status()).ready, false)
  assert.equal(indexRequests, 1)
  assert.equal(destinationRequests, 0)
  assert.deepEqual(
    await index.search(
      randomUUID(),
      [source('企业制度')],
      '  !!! ',
      2,
      AbortSignal.timeout(1000),
    ),
    [],
  )
  assert.deepEqual(
    await index.search(randomUUID(), [], '报销', 2, AbortSignal.timeout(1000)),
    [],
  )
  assert.equal(indexRequests, 1)
})
