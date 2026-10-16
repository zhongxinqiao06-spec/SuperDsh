import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { IdentityService } from '../identity/service.ts'
import { ConnectorHub } from '../devices/connector-hub.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { QdrantKnowledgeIndex } from '../agents/knowledge-index.ts'
import { executeAgentTool } from '../agents/execution.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t) {
  let closeDatabase
  const db = await withTestDatabase({
    after: (close) => {
      closeDatabase = close
    },
  })
  let hub
  t.after(async () => {
    try {
      await hub?.close()
    } finally {
      await closeDatabase()
    }
  })
  const identity = new IdentityService(db, {
    secret: 'synthetic-composition-secret',
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
  const member = await identity.createUser({
    username: 'member',
    displayName: 'Synthetic member',
    password: 'synthetic-member-password',
  })
  hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-composition-secret',
    authenticateToken: identity.authenticateToken.bind(identity),
    getUser: identity.getUser.bind(identity),
  })
  const options = {
    db,
    hub,
    getAccount: identity.getUser.bind(identity),
    audit: identity.audit.bind(identity),
    knowledgeIndex: new QdrantKnowledgeIndex(
      process.env.SUPERDSH_NODE_TEST_QDRANT_URL,
    ),
  }
  const business = new BusinessAgentService(options)
  const resources = new AgentResourceService(options)
  await resources.ensureDefaults(manager)
  const upload = (content, name = `synthetic-${randomUUID()}.md`) =>
    business.upload(manager, {
      name,
      kind: 'knowledge',
      contentBase64: Buffer.from(content).toString('base64'),
    })
  const { connector } = await hub.store.createConnector(member.userId, {
    name: 'Synthetic employee runtime',
  })
  await db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connector.id],
  )
  const session = async () => {
    const id = `session-${randomUUID()}`
    const now = new Date().toISOString()
    await db.query(
      "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES($1,$2,'dsh','dsh','idle',1,1,1,$3,$3)",
      [id, connector.id, now],
    )
    return hub.store.session(id, member.userId)
  }
  return {
    db,
    identity,
    manager,
    member,
    business,
    resources,
    options,
    upload,
    session,
  }
}

const agent = (changes = {}) => ({
  name: 'Synthetic company agent',
  description: 'Synthetic company policy',
  instructions: 'Search company policy and cite the source.',
  knowledgeBaseIds: [],
  knowledgeAssetIds: [],
  templateAssetIds: [],
  skillIds: ['company-knowledge'],
  toolIds: ['knowledge_search'],
  published: true,
  ...changes,
})
const knowledge = (assetIds) => ({
  name: 'Company policy',
  description: 'Synthetic policy knowledge base',
  assetIds,
  enabled: true,
})

test('knowledge edits affect new sessions while existing sessions keep frozen assets, skill instructions and tool settings', async (t) => {
  const f = await fixture(t)
  const oldAsset = await f.upload('报销标准：旧版制度要求发票和经理审批。')
  const nextAsset = await f.upload('报销标准：新版制度要求发票和财务审批。')
  const base = await f.resources.saveKnowledge(
    f.manager,
    knowledge([oldAsset.id]),
  )
  const selected = await f.business.save(
    f.manager,
    agent({ knowledgeBaseIds: [base.id] }),
  )
  const first = await f.session()
  await f.business.bind(f.member, first, selected)
  const before = await f.business.binding(f.member.userId, first.id)
  await f.resources.saveKnowledge(
    f.manager,
    { ...base, assetIds: [nextAsset.id] },
    base.id,
  )
  const catalog = await f.resources.catalog(f.manager)
  const skill = catalog.skills.find((item) => item.id === 'company-knowledge')
  const tool = catalog.tools.find((item) => item.id === 'knowledge_search')
  await f.resources.saveSkill(
    f.manager,
    {
      ...skill,
      instructions:
        'New session instructions: cite the revised financial policy.',
    },
    skill.id,
  )
  await f.resources.saveTool(
    f.manager,
    { ...tool, settings: { maxResults: 1 } },
    tool.id,
  )
  const second = await f.session()
  await f.business.bind(
    f.member,
    second,
    await f.business.available(f.member, selected.id),
  )
  const after = await f.business.binding(f.member.userId, second.id)
  assert.deepEqual(before.definition.knowledgeAssetIds, [oldAsset.id])
  assert.deepEqual(after.definition.knowledgeAssetIds, [nextAsset.id])
  assert.equal(before.knowledgeBases[0].version, 1)
  assert.equal(after.knowledgeBases[0].version, 2)
  assert.equal(before.skills[0].instructions, skill.instructions)
  assert.equal(
    after.skills[0].instructions,
    'New session instructions: cite the revised financial policy.',
  )
  assert.deepEqual(before.tools[0].settings, {})
  assert.deepEqual(after.tools[0].settings, { maxResults: 1 })
  assert.deepEqual(await f.business.binding(f.member.userId, first.id), before)
  for (const [record, expected] of [
    [first, '经理审批'],
    [second, '财务审批'],
  ]) {
    const reply = await executeAgentTool(
      f.business,
      f.member.userId,
      record.id,
      'knowledge_search',
      { query: '报销标准' },
      AbortSignal.timeout(15000),
    )
    assert.match(reply.sources[0].content, new RegExp(expected))
  }
  const current = await f.resources.getKnowledge(f.manager, base.id)
  await f.resources.saveKnowledge(
    f.manager,
    { ...current, enabled: false },
    current.id,
  )
  await assert.rejects(
    executeAgentTool(
      f.business,
      f.member.userId,
      first.id,
      'knowledge_search',
      { query: '报销' },
      AbortSignal.timeout(15000),
    ),
    (error) => error.status === 403,
  )
  await assert.rejects(
    f.business.bind(f.member, await f.session(), selected),
    (error) => error.status === 422,
  )
})

test('legacy direct-asset agents remain usable by members and tool disabling revokes legacy bindings', async (t) => {
  const f = await fixture(t)
  const asset = await f.upload('差旅报销需要提供原始发票，不得重复报销。')
  const selected = await f.business.save(
    f.manager,
    agent({ knowledgeAssetIds: [asset.id] }),
  )
  const record = await f.session()
  await f.business.bind(f.member, record, selected)
  const binding = await f.business.binding(f.member.userId, record.id)
  delete binding.resourceOwnerId
  delete binding.knowledgeBases
  delete binding.skills
  delete binding.tools
  delete binding.definition.knowledgeBaseIds
  await f.db.query(
    'UPDATE business_agent_sessions SET binding_json=$2 WHERE session_id=$1',
    [record.id, JSON.stringify(binding)],
  )
  const output = await executeAgentTool(
    f.business,
    f.member.userId,
    record.id,
    'knowledge_search',
    { query: '差旅报销' },
    AbortSignal.timeout(15000),
  )
  assert.equal(output.sources[0].assetId, asset.id)
  await assert.rejects(
    f.business.binding(f.manager.userId, record.id),
    (error) => error.status === 404,
  )
  const tool = (await f.resources.catalog(f.manager)).tools.find(
    (item) => item.id === 'knowledge_search',
  )
  await f.resources.saveTool(f.manager, { ...tool, enabled: false }, tool.id)
  await assert.rejects(
    executeAgentTool(
      f.business,
      f.member.userId,
      record.id,
      'knowledge_search',
      { query: '差旅报销' },
      AbortSignal.timeout(15000),
    ),
    (error) => error.status === 403,
  )
})

test('agent reference creation waits for resource deletion and cannot commit a dangling knowledge reference', async (t) => {
  const f = await fixture(t)
  const base = await f.resources.saveKnowledge(f.manager, knowledge([]))
  let acquired, release
  const ready = new Promise((done) => {
    acquired = done
  })
  const unblock = new Promise((done) => {
    release = done
  })
  const deleting = f.db.transaction(async (connection) => {
    await connection.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`business-agent-references:${f.manager.userId}`],
    )
    const scoped = new AgentResourceService({
      ...f.options,
      db: {
        ...f.db,
        query: connection.query,
        transaction: (operation) => operation(connection),
      },
    })
    acquired()
    await unblock
    await scoped.remove('knowledge-bases', f.manager, base.id)
  })
  await ready
  const creating = f.business
    .save(f.manager, agent({ knowledgeBaseIds: [base.id] }))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
  try {
    const deadline = Date.now() + 3000
    let waiting = false
    while (Date.now() < deadline) {
      const rows = await f.db.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
      )
      if (rows.length) {
        waiting = true
        break
      }
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.equal(
      waiting,
      true,
      'Agent save must acquire the same owner lock as resource deletion',
    )
  } finally {
    release()
  }
  await deleting
  const result = await creating
  assert.equal(result.error?.status, 422)
  assert.equal(
    (await f.db.query('SELECT COUNT(*) AS count FROM business_agents'))[0]
      .count,
    '0',
  )
})

test('catalog keeps old referenced assets beyond 500 uploads while returning only bounded previews', async (t) => {
  const f = await fixture(t)
  const earliest = await f.upload('Synthetic reference policy. '.repeat(100))
  const now = new Date().toISOString()
  await f.db.query(
    "INSERT INTO business_agent_assets(id,owner_user_id,name,kind,size,media_type,sha256,content,extracted_text,created_at) SELECT 'bulk-'||n::text,$1,'Synthetic '||n::text||'.md','knowledge',1,'text/plain','hash-'||n::text,decode('61','hex'),'Synthetic document.',$2 FROM generate_series(1,501) AS n",
    [f.manager.userId, now],
  )
  const catalog = await f.business.catalog(f.manager)
  assert.equal(catalog.assets.length, 502)
  const selected = catalog.assets.find((item) => item.id === earliest.id)
  assert.ok(
    selected,
    'Older selected assets must not disappear from knowledge editors',
  )
  assert.equal(selected.preview.length, 1200)
  assert.equal(Object.hasOwn(selected, 'content'), false)
  assert.equal(Object.hasOwn(selected, 'contentBase64'), false)
})
