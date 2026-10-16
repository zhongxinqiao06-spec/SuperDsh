import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createApplication } from '../application.ts'
import { RedisCoordinator } from '../infrastructure/redis-coordinator.ts'
import { ensureSchema } from '../infrastructure/schema.ts'
import { IdentityService } from '../identity/service.ts'
import { defaultMenuItems } from '../management/navigation.ts'
import { executeAgentTool } from '../agents/execution.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t) {
  let cleanupDatabase
  const db = await withTestDatabase({
    after: (fn) => {
      cleanupDatabase = fn
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-business-api-中文-'))
  const redis = new RedisCoordinator(
    process.env.SUPERDSH_NODE_TEST_REDIS_URL,
    db.testUrl,
  )
  let app, server
  t.after(async () => {
    if (server)
      await new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      })
    try {
      await app?.service.close()
      await redis.close()
    } finally {
      await cleanupDatabase()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(directory.includes('superdsh-business-api-中文-'))
      await rm(directory, { recursive: true, force: true })
    }
  })
  await redis.start()
  const configuration = {
    databaseUrl: db.testUrl,
    redisUrl: process.env.SUPERDSH_NODE_TEST_REDIS_URL,
    qdrantUrl: process.env.SUPERDSH_NODE_TEST_QDRANT_URL,
    secret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64url'),
    dataDirectory: directory,
    filesDirectory: join(directory, 'files'),
    hostname: '127.0.0.1',
    port: 0,
    apiPort: 0,
    origins: [],
    setupToken: 'synthetic-agent-setup',
    dev: true,
  }
  app = createApplication({ configuration, database: db, redis, log() {} })
  await app.identity.seedBuiltinRoles()
  const admin = await app.identity.createUser(
    {
      username: 'manager',
      displayName: 'Manager',
      password: 'synthetic-manager-password',
    },
    { role: 'admin' },
  )
  const otherAdmin = await app.identity.createUser(
    {
      username: 'other-manager',
      displayName: 'Other manager',
      password: 'synthetic-other-password',
    },
    { role: 'admin' },
  )
  const member = await app.identity.createUser({
    username: 'employee',
    displayName: 'Employee',
    password: 'synthetic-employee-password',
  })
  const logins = new Map()
  for (const user of [admin, otherAdmin, member])
    logins.set(user.userId, await app.identity.issueLogin(user.userId))
  server = createServer((req, res) =>
    app.handle(req, res, { signal: AbortSignal.timeout(15000) }),
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}/api/v2`
  const request = async (path, method = 'GET', body, user = admin) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-SuperDsh-Agent-Preparation': 'deferred',
        ...(user
          ? { Authorization: `Bearer ${logins.get(user.userId).accessToken}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  return { db, app, admin, otherAdmin, member, request }
}

const definition = (overrides = {}) => ({
  name: '企业资料助手',
  description: '回答虚构企业资料中的问题',
  instructions: '先检索绑定资料，再回答并引用来源；不得编造。',
  knowledgeAssetIds: [],
  templateAssetIds: [],
  skillIds: ['company-knowledge'],
  toolIds: ['knowledge_search'],
  published: false,
  ...overrides,
})
const upload = (name = 'policy.md') => ({
  name,
  kind: 'knowledge',
  contentBase64: Buffer.from(
    '# Fixture company\nTravel reimbursement requires a receipt.',
  ).toString('base64'),
})

test('business Agent management requires permissions while published definitions are available to employees', async (t) => {
  const f = await fixture(t)
  for (const path of ['/admin/agents', '/admin/agents/catalog'])
    assert.equal(
      (await f.request(path, 'GET', undefined, f.member)).status,
      403,
    )
  assert.equal((await f.request('/agents', 'GET', undefined, null)).status, 401)
  assert.equal(
    (await f.request('/admin/agents', 'POST', definition(), f.member)).status,
    403,
  )
  const created = await f.request('/admin/agents', 'POST', definition())
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(
    (await f.request('/agents', 'GET', undefined, f.member)).body.items.length,
    0,
  )
  const updated = await f.request(
    `/admin/agents/${created.body.agent.id}`,
    'PUT',
    { ...definition(), published: true, version: 1 },
  )
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.agent.version, 2)
  const available = await f.request('/agents', 'GET', undefined, f.member)
  assert.equal(available.status, 200)
  assert.equal(available.body.items[0].id, created.body.agent.id)
  assert.equal(
    (await f.db.query('SELECT owner_user_id FROM server_agents')).length,
    0,
    'management must not prepare a runtime',
  )
})

test('asset upload is bounded, deduplicated and private even from another administrator', async (t) => {
  const f = await fixture(t)
  const first = await f.request('/admin/agents/assets', 'POST', upload())
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.asset.kind, 'knowledge')
  assert.match(first.body.asset.preview, /reimbursement/)
  assert.equal(
    (await f.request('/admin/agents/assets', 'POST', upload())).body.asset.id,
    first.body.asset.id,
  )
  const path = `/admin/agents/assets/${first.body.asset.id}/download`
  assert.equal(
    (await f.request(path, 'GET', undefined, f.otherAdmin)).status,
    404,
  )
  assert.equal((await f.request(path, 'GET', undefined, f.member)).status, 403)
  const downloaded = await f.request(path)
  assert.equal(downloaded.body.contentBase64, upload().contentBase64)
  assert.equal(downloaded.body.name, 'policy.md')
  assert.equal(
    (await f.request('/admin/agents/catalog', 'GET', undefined, f.otherAdmin))
      .body.assets.length,
    0,
  )
  const bind = await f.request(
    '/admin/agents',
    'POST',
    definition({ knowledgeAssetIds: [first.body.asset.id] }),
    f.otherAdmin,
  )
  assert.equal(bind.status, 422)
  for (const invalid of [
    { ...upload(), name: '../policy.md' },
    { ...upload(), contentBase64: 'not valid base64' },
    { ...upload(), kind: 'presentation-template' },
  ])
    assert.equal(
      (await f.request('/admin/agents/assets', 'POST', invalid)).status,
      422,
    )
  assert.equal(
    (
      await f.request('/admin/agents/assets', 'POST', {
        ...upload(),
        contentBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'),
      })
    ).status,
    413,
  )
})

test('drafts cannot displace published choices or execute through an owner bypass, and unpublishing revokes owner tools', async (t) => {
  const f = await fixture(t)
  const asset = (await f.request('/admin/agents/assets', 'POST', upload())).body
    .asset
  const published = (
    await f.request(
      '/admin/agents',
      'POST',
      definition({
        name: 'Published choice',
        published: true,
        knowledgeAssetIds: [asset.id],
      }),
    )
  ).body.agent
  const draft = (
    await f.request(
      '/admin/agents',
      'POST',
      definition({ name: 'Newer draft' }),
    )
  ).body.agent
  for (const account of [f.admin, f.member]) {
    const choices = await f.request(
      '/agents?pageSize=1',
      'GET',
      undefined,
      account,
    )
    assert.equal(choices.status, 200)
    assert.equal(choices.body.total, 1)
    assert.equal(choices.body.items[0].id, published.id)
    await assert.rejects(
      f.app.business.available(account, draft.id),
      (error) => error.status === 404,
    )
  }
  assert.equal((await f.request('/admin/agents')).body.total, 2)
  const { connector } = await f.app.hub.store.createConnector(f.admin.userId, {
    name: 'Synthetic owner runtime',
  })
  await f.db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connector.id],
  )
  const denied = await f.request('/sessions/create-and-start', 'POST', {
    connectorId: connector.id,
    agentDefinitionId: draft.id,
    clientMessageId: 'owner-draft-request',
    content: 'Do not run this draft',
  })
  assert.equal(denied.status, 404)
  assert.match(denied.body.detail, /未发布|已停用/)
  assert.equal((await f.db.query('SELECT * FROM sessions')).length, 0)

  const now = new Date().toISOString()
  await f.db.query(
    "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES('owner-session',$1,'dsh','dsh','idle',1,1,1,$2,$2)",
    [connector.id, now],
  )
  const session = await f.app.hub.store.session('owner-session', f.admin.userId)
  await f.app.business.bind(f.admin, session, published)
  const invoke = () =>
    executeAgentTool(
      f.app.business,
      f.admin.userId,
      session.id,
      'knowledge_search',
      { query: 'receipt' },
      new AbortController().signal,
    )
  assert.equal((await invoke()).sources[0].assetId, asset.id)
  const revoked = await f.request(`/admin/agents/${published.id}`, 'PUT', {
    ...published,
    published: false,
  })
  assert.equal(revoked.status, 200)
  await assert.rejects(invoke, (error) => error.status === 404)
  assert.equal((await f.request('/agents')).body.total, 0)
})

test('agent search and pagination are stable and version checks reject concurrent overwrites', async (t) => {
  const f = await fixture(t)
  const created = []
  for (const name of ['Report A', 'Report B', 'Inventory'])
    created.push(
      (await f.request('/admin/agents', 'POST', definition({ name }))).body
        .agent,
    )
  const first = await f.request('/admin/agents?page=1&pageSize=1&search=Report')
  const second = await f.request(
    '/admin/agents?page=2&pageSize=1&search=Report',
  )
  assert.equal(first.body.total, 2)
  assert.equal(first.body.items.length, 1)
  assert.notEqual(first.body.items[0].id, second.body.items[0].id)
  const changes = await Promise.all(
    ['Updated A', 'Updated B'].map((name) =>
      f.request(
        `/admin/agents/${created[0].id}`,
        'PUT',
        definition({ name, version: 1 }),
      ),
    ),
  )
  assert.deepEqual(changes.map((item) => item.status).sort(), [200, 409])
  assert.equal(
    (
      await f.request(
        `/admin/agents/${created[0].id}`,
        'PUT',
        definition({ version: 2 }),
        f.otherAdmin,
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await f.request(
        `/admin/agents/${created[0].id}`,
        'DELETE',
        undefined,
        f.otherAdmin,
      )
    ).status,
    404,
  )
  assert.equal(
    (await f.request(`/admin/agents/${created[0].id}`, 'DELETE')).status,
    204,
  )
  assert.equal((await f.request('/admin/agents')).body.total, 2)
  assert.equal(
    (
      await f.db.query('SELECT deleted_at FROM business_agents WHERE id=$1', [
        created[0].id,
      ])
    )[0].deleted_at !== null,
    true,
  )
})

test('agent configuration rejects unregistered capabilities, mismatched assets and missing skill tools', async (t) => {
  const f = await fixture(t)
  const asset = (await f.request('/admin/agents/assets', 'POST', upload())).body
    .asset
  for (const invalid of [
    definition({ toolIds: ['shell'] }),
    definition({ skillIds: ['unregistered'] }),
    definition({ toolIds: [] }),
    definition({ templateAssetIds: [asset.id] }),
    definition({ knowledgeAssetIds: [asset.id, asset.id] }),
    definition({ published: 'true' }),
    definition({ instructions: 'x'.repeat(6001) }),
  ]) {
    const response = await f.request('/admin/agents', 'POST', invalid)
    assert.equal(response.status, 422, JSON.stringify(response.body))
  }
  assert.equal((await f.request('/admin/agents')).body.total, 0)
})

test('demo initialization is idempotent and produces actual retrievable Office templates', async (t) => {
  const f = await fixture(t)
  const first = await f.request('/admin/agents/demo', 'POST', {})
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const second = await f.request('/admin/agents/demo', 'POST', {})
  assert.deepEqual(
    second.body.agents.map((item) => item.id),
    first.body.agents.map((item) => item.id),
  )
  assert.deepEqual(
    second.body.assets.map((item) => item.id),
    first.body.assets.map((item) => item.id),
  )
  assert.equal(first.body.agents.length, 3)
  assert.equal(first.body.assets.length, 4)
  assert.equal(
    (await f.request('/agents', 'GET', undefined, f.member)).body.items.length,
    3,
  )
  assert.equal((await f.request('/admin/agents/catalog')).body.assets.length, 4)
  for (const asset of first.body.assets.filter((item) =>
    item.kind.endsWith('-template'),
  )) {
    const response = await f.request(
      `/admin/agents/assets/${asset.id}/download`,
    )
    assert.equal(response.status, 200)
    assert.equal(
      Buffer.from(response.body.contentBase64, 'base64')
        .subarray(0, 2)
        .toString(),
      'PK',
    )
  }
})

test('published Agent usage does not grant administrators access to another users session outputs or tools', async (t) => {
  const f = await fixture(t)
  const asset = (await f.request('/admin/agents/assets', 'POST', upload())).body
    .asset
  const selected = (
    await f.request(
      '/admin/agents',
      'POST',
      definition({ published: true, knowledgeAssetIds: [asset.id] }),
    )
  ).body.agent
  const { connector } = await f.app.hub.store.createConnector(f.member.userId, {
    name: 'Synthetic managed runtime',
  })
  await f.db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connector.id],
  )
  const now = new Date().toISOString()
  await f.db.query(
    "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES('private-session',$1,'dsh','dsh','idle',1,1,1,$2,$2)",
    [connector.id, now],
  )
  const session = await f.app.hub.store.session(
    'private-session',
    f.member.userId,
  )
  await f.app.business.bind(f.member, session, selected)
  const metadata = await f.app.files.save(
    f.member.userId,
    session.id,
    'report.txt',
    Buffer.from('Synthetic private report'),
    'text/plain',
    'private-artifact',
  )
  await f.db.query(
    'INSERT INTO business_agent_artifacts(id,session_id,metadata_json,created_at) VALUES($1,$2,$3,$4)',
    ['private-artifact', session.id, JSON.stringify(metadata), now],
  )
  const outputs = await f.request(
    '/sessions/private-session/agent-artifacts',
    'GET',
    undefined,
    f.member,
  )
  assert.equal(outputs.status, 200, JSON.stringify(outputs.body))
  assert.equal(outputs.body.agentDefinition.id, selected.id)
  assert.equal(outputs.body.items[0].fileId, metadata.fileId)
  for (const other of [f.admin, f.otherAdmin]) {
    assert.equal(
      (
        await f.request(
          '/sessions/private-session/agent-artifacts',
          'GET',
          undefined,
          other,
        )
      ).status,
      404,
    )
    assert.equal(
      (
        await f.request(
          `/sessions/private-session/attachments/${metadata.fileId}`,
          'GET',
          undefined,
          other,
        )
      ).status,
      404,
    )
    await assert.rejects(
      executeAgentTool(
        f.app.business,
        other.userId,
        session.id,
        'knowledge_search',
        { query: 'receipt' },
        new AbortController().signal,
      ),
      (error) => error.status === 404,
    )
  }
  const result = await executeAgentTool(
    f.app.business,
    f.member.userId,
    session.id,
    'knowledge_search',
    { query: 'receipt' },
    new AbortController().signal,
  )
  assert.equal(result.sources[0].assetId, asset.id)
  assert.match(result.sources[0].content, /receipt/)
  await assert.rejects(
    executeAgentTool(
      f.app.business,
      f.member.userId,
      session.id,
      'spreadsheet_report',
      { __callId: 'unauthorized-tool' },
      new AbortController().signal,
    ),
    (error) => error.status === 403,
  )
  await f.request(
    `/admin/agents/${selected.id}`,
    'PUT',
    definition({
      version: selected.version,
      published: false,
      knowledgeAssetIds: [asset.id],
    }),
  )
  await assert.rejects(
    executeAgentTool(
      f.app.business,
      f.member.userId,
      session.id,
      'knowledge_search',
      { query: 'receipt' },
      new AbortController().signal,
    ),
    (error) => error.status === 404,
  )
})

test('v2_39 migration adds Agent navigation and permission without altering owners, hashes, ciphertext or custom navigation', async (t) => {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, {
    secret: 'synthetic-agent-migration-secret',
  })
  await identity.seedBuiltinRoles()
  const user = await identity.createUser(
    {
      username: 'legacy-admin',
      displayName: 'Legacy admin',
      password: 'synthetic-preserved-password',
    },
    { role: 'admin' },
  )
  const before = (
    await db.query('SELECT * FROM users WHERE id=$1', [user.userId])
  )[0]
  for (const table of [
    'business_knowledge_bases',
    'business_agent_skills',
    'business_agent_tools',
    'business_agent_artifacts',
    'business_agent_sessions',
    'business_agents',
    'business_agent_assets',
  ])
    await db.query(`DROP TABLE ${table}`)
  await db.query('ALTER TABLE sessions DROP COLUMN agent_definition_json')
  const now = new Date().toISOString()
  await db.query(
    "INSERT INTO connectors(id,user_id,name,status,token_hash,token_prefix,created_at,updated_at) VALUES('legacy-connector',$1,'Owned device','offline','synthetic-token-hash','prefix',$2,$2)",
    [user.userId, now],
  )
  await db.query(
    "INSERT INTO platform_model_providers(id,name,protocol,base_url,key_ciphertext,models_json,created_at,updated_at) VALUES('legacy-provider','Provider','openai-completions','https://fixture.example','synthetic-ciphertext','[]',$1,$1)",
    [now],
  )
  const originalMenus = defaultMenuItems()
    .filter((item) => item.moduleId !== 'agents')
    .map((item) =>
      item.moduleId === 'overview'
        ? { ...item, title: 'Custom overview' }
        : item,
    )
  await db.query(
    "INSERT INTO navigation_settings(id,version,items_json,updated_at) VALUES('global',7,$1,$2)",
    [JSON.stringify(originalMenus), now],
  )
  const grants = (await identity.getUser(user.userId)).permissions.filter(
    (permission) => permission !== 'agents.manage',
  )
  await db.query("UPDATE roles SET permissions_json=$1 WHERE id='admin'", [
    JSON.stringify(grants),
  ])
  await db.query("UPDATE alembic_version SET version_num='v2_39'")
  await ensureSchema(db)
  assert.equal(
    (await db.query('SELECT version_num FROM alembic_version'))[0].version_num,
    'v2_42',
  )
  assert.ok(
    (await identity.getUser(user.userId)).permissions.includes('agents.manage'),
  )
  const navigation = (
    await db.query("SELECT * FROM navigation_settings WHERE id='global'")
  )[0]
  const menus = JSON.parse(navigation.items_json)
  assert.equal(Number(navigation.version), 8)
  assert.equal(menus.filter((item) => item.moduleId === 'agents').length, 1)
  assert.equal(
    menus.find((item) => item.moduleId === 'overview').title,
    'Custom overview',
  )
  const after = (
    await db.query('SELECT * FROM users WHERE id=$1', [user.userId])
  )[0]
  assert.equal(after.password_hash, before.password_hash)
  assert.equal(
    (
      await db.query(
        "SELECT user_id FROM connectors WHERE id='legacy-connector'",
      )
    )[0].user_id,
    user.userId,
  )
  assert.equal(
    (
      await db.query(
        "SELECT key_ciphertext FROM platform_model_providers WHERE id='legacy-provider'",
      )
    )[0].key_ciphertext,
    'synthetic-ciphertext',
  )
  await ensureSchema(db)
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT version FROM navigation_settings WHERE id='global'",
        )
      )[0].version,
    ),
    8,
  )
})
