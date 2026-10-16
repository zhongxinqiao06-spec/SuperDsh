import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { ApiRouter } from '../http/api-router.ts'
import { IdentityService } from '../identity/service.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { registerAgentResourceRoutes } from '../agents/resource-routes.ts'
import { ensureSchema } from '../infrastructure/schema.ts'
import { defaultMenuItems } from '../management/navigation.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t) {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, {
    secret: 'synthetic-resource-api-secret',
  })
  await identity.seedBuiltinRoles()
  const users = []
  for (const [username, role] of [
    ['manager', 'admin'],
    ['other-manager', 'admin'],
    ['employee', 'member'],
  ])
    users.push(
      await identity.createUser(
        {
          username,
          password: `synthetic-${username}-password`,
          displayName: username,
        },
        { role },
      ),
    )
  const [admin, other, member] = users
  const tokens = new Map()
  for (const user of users)
    tokens.set(
      user.userId,
      (await identity.issueLogin(user.userId)).accessToken,
    )
  const options = { db, audit: identity.audit.bind(identity) }
  const resources = new AgentResourceService(options)
  const business = new BusinessAgentService(options)
  await resources.ensureDefaults(admin)
  await resources.ensureDefaults(other)
  const router = new ApiRouter(identity.authorize)
  registerAgentResourceRoutes(router, resources)
  const server = createServer((req, res) =>
    router.handle(req, res, { signal: AbortSignal.timeout(10000) }),
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  )
  const request = async (path, method = 'GET', body, user = admin) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v2${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.get(user.userId)}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    )
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  const asset = (
    owner = admin,
    name = 'synthetic-policy.md',
    content = 'Synthetic policy: receipts are required.',
  ) =>
    business.upload(owner, {
      name,
      kind: 'knowledge',
      contentBase64: Buffer.from(content).toString('base64'),
    })
  return {
    db,
    identity,
    resources,
    business,
    request,
    asset,
    admin,
    other,
    member,
  }
}

const knowledge = (changes = {}) => ({
  name: 'Company policy',
  description: 'Synthetic company documents',
  enabled: true,
  assetIds: [],
  ...changes,
})
const skill = (changes = {}) => ({
  name: 'Policy reviewer',
  description: 'Find evidence before answering',
  enabled: true,
  instructions: 'Search company policy and cite source paragraphs.',
  requiredToolIds: ['knowledge_search'],
  ...changes,
})

test('independent knowledge and skill lists paginate, persist edits and enforce manager ownership', async (t) => {
  const f = await fixture(t)
  const asset = await f.asset()
  const ids = []
  for (const name of ['Company A', 'Company B', 'Sales']) {
    const result = await f.request(
      '/admin/knowledge-bases',
      'POST',
      knowledge({ name, assetIds: [asset.id] }),
    )
    assert.equal(result.status, 201, JSON.stringify(result.body))
    ids.push(result.body.knowledgeBase.id)
  }
  const page = await f.request(
    '/admin/knowledge-bases?search=Company&pageSize=1&page=1',
  )
  const next = await f.request(
    '/admin/knowledge-bases?search=Company&pageSize=1&page=2',
  )
  assert.equal(page.body.total, 2)
  assert.equal(page.body.items.length, 1)
  assert.notEqual(page.body.items[0].id, next.body.items[0].id)
  assert.equal(
    (await f.request('/admin/knowledge-bases', 'GET', undefined, f.other)).body
      .total,
    0,
  )
  for (const path of [
    '/admin/knowledge-bases',
    '/admin/skills',
    '/admin/tools',
  ])
    assert.equal(
      (await f.request(path, 'GET', undefined, f.member)).status,
      403,
    )
  assert.equal(
    (
      await f.request(
        `/admin/knowledge-bases/${ids[0]}`,
        'PUT',
        knowledge({ version: 1 }),
        f.other,
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await f.request(
        '/admin/knowledge-bases',
        'POST',
        knowledge({ assetIds: [asset.id] }),
        f.other,
      )
    ).status,
    422,
  )
  const updates = await Promise.all(
    ['First change', 'Second change'].map((name) =>
      f.request(
        `/admin/knowledge-bases/${ids[0]}`,
        'PUT',
        knowledge({ name, version: 1, assetIds: [asset.id] }),
      ),
    ),
  )
  assert.deepEqual(updates.map((result) => result.status).sort(), [200, 409])
  const persisted = (
    await new AgentResourceService(f.resources.options).catalog(f.admin)
  ).knowledgeBases.find((item) => item.id === ids[0])
  assert.equal(persisted.version, 2)
  assert.deepEqual(persisted.assetIds, [asset.id])
  const created = await f.request('/admin/skills', 'POST', skill())
  assert.equal(created.status, 201)
  const edited = await f.request(
    `/admin/skills/${created.body.skill.id}`,
    'PUT',
    {
      ...created.body.skill,
      instructions: 'Extract only approved policy clauses.',
    },
  )
  assert.equal(
    edited.body.skill.instructions,
    'Extract only approved policy clauses.',
  )
  assert.equal(
    (await f.resources.catalog(f.admin)).skills.find(
      (item) => item.id === created.body.skill.id,
    ).version,
    2,
  )
  assert.equal(
    (
      await f.request(
        `/admin/skills/${created.body.skill.id}`,
        'DELETE',
        undefined,
        f.other,
      )
    ).status,
    404,
  )
})

test('configured tools have versioned persisted defaults, validate supported settings and cannot register executable code', async (t) => {
  const f = await fixture(t)
  const catalog = await f.resources.catalog(f.admin)
  assert.equal(catalog.tools.length, 3)
  const tool = catalog.tools.find((item) => item.id === 'spreadsheet_report')
  const change = await f.request(`/admin/tools/${tool.id}`, 'PUT', {
    ...tool,
    name: 'Company Excel export',
    settings: {
      companyName: 'Synthetic Northwind',
      title: 'Quarterly summary',
    },
  })
  assert.equal(change.status, 200, JSON.stringify(change.body))
  assert.equal(change.body.tool.version, 2)
  assert.equal(
    (
      await f.resources.resolve(
        f.admin.userId,
        [],
        ['sales-analysis'],
        [tool.id],
      )
    ).tools[0].settings.title,
    'Quarterly summary',
  )
  assert.deepEqual(
    (await f.resources.catalog(f.other)).tools.find(
      (item) => item.id === tool.id,
    ).settings,
    {},
  )
  assert.equal(
    (await f.request(`/admin/tools/${tool.id}`, 'PUT', tool)).status,
    409,
  )
  assert.equal((await f.request('/admin/tools/shell', 'PUT', tool)).status, 404)
  for (const settings of [
    { command: 'execute' },
    { maxResults: 2 },
    { title: 'x'.repeat(161) },
  ])
    assert.equal(
      (
        await f.request(`/admin/tools/${tool.id}`, 'PUT', {
          ...change.body.tool,
          settings,
        })
      ).status,
      422,
    )
  const search = catalog.tools.find((item) => item.id === 'knowledge_search')
  for (const settings of [
    { maxResults: 0 },
    { maxResults: 9 },
    { maxResults: 1.1 },
    { title: 'unsupported' },
  ])
    assert.equal(
      (
        await f.request('/admin/tools/knowledge_search', 'PUT', {
          ...search,
          settings,
        })
      ).status,
      422,
    )
  const limited = await f.request('/admin/tools/knowledge_search', 'PUT', {
    ...search,
    settings: { maxResults: 2 },
    enabled: false,
  })
  assert.equal(limited.status, 200)
  await assert.rejects(
    f.resources.resolve(
      f.admin.userId,
      [],
      ['company-knowledge'],
      ['knowledge_search'],
    ),
    (error) => error.status === 422,
  )
  await assert.rejects(
    f.resources.assertActive(f.admin.userId, [], [], ['knowledge_search']),
    (error) => error.status === 403,
  )
})

test('resource deletion protects agent references and one-time defaults never resurrect deleted or disabled resources', async (t) => {
  const f = await fixture(t)
  const base = (await f.request('/admin/knowledge-bases', 'POST', knowledge()))
    .body.knowledgeBase
  const configured = (await f.request('/admin/skills', 'POST', skill())).body
    .skill
  const now = new Date().toISOString()
  await f.db.query(
    'INSERT INTO business_agents(id,owner_user_id,name,version,published,definition_json,created_at,updated_at) VALUES($1,$2,$3,1,0,$4,$5,$5)',
    [
      'references',
      f.admin.userId,
      'Referenced resources',
      JSON.stringify({
        knowledgeBaseIds: [base.id],
        skillIds: [configured.id],
      }),
      now,
    ],
  )
  for (const [kind, item] of [
    ['knowledge-bases', base],
    ['skills', configured],
  ])
    assert.equal(
      (await f.request(`/admin/${kind}/${item.id}`, 'DELETE')).status,
      409,
    )
  await f.db.query('UPDATE business_agents SET deleted_at=$1 WHERE id=$2', [
    now,
    'references',
  ])
  assert.equal(
    (await f.request(`/admin/knowledge-bases/${base.id}`, 'DELETE')).status,
    204,
  )
  assert.equal(
    (await f.request(`/admin/skills/${configured.id}`, 'DELETE')).status,
    204,
  )
  assert.equal(
    (await f.request('/admin/skills/company-knowledge', 'DELETE')).status,
    204,
  )
  const tool = (await f.resources.catalog(f.admin)).tools.find(
    (item) => item.id === 'knowledge_search',
  )
  await f.request('/admin/tools/knowledge_search', 'PUT', {
    ...tool,
    enabled: false,
  })
  await Promise.all([
    f.resources.ensureDefaults(f.admin),
    f.resources.ensureDefaults(f.admin),
  ])
  const catalog = await f.resources.catalog(f.admin)
  assert.equal(catalog.knowledgeBases.length, 0)
  assert.equal(
    catalog.skills.some((item) => item.id === 'company-knowledge'),
    false,
  )
  assert.equal(
    catalog.tools.find((item) => item.id === 'knowledge_search').enabled,
    false,
  )
  await assert.rejects(
    f.resources.resolve(f.admin.userId, [base.id], [], []),
    (error) => error.status === 422,
  )
  assert.equal(
    (
      await f.request(
        '/admin/skills',
        'POST',
        skill({ requiredToolIds: ['shell'] }),
      )
    ).status,
    422,
  )
  assert.equal(
    (
      await f.request(
        '/admin/skills',
        'POST',
        skill({ requiredToolIds: ['knowledge_search', 'knowledge_search'] }),
      )
    ).status,
    422,
  )
})

test('resource snapshots retain instructions while active checks revoke disabled resources', async (t) => {
  const f = await fixture(t)
  const before = await f.resources.resolve(
    f.admin.userId,
    [],
    ['company-knowledge'],
    ['knowledge_search'],
  )
  const selected = before.skills[0]
  await f.request(`/admin/skills/${selected.id}`, 'PUT', {
    ...selected,
    instructions: 'New instructions for new conversations.',
    requiredToolIds: ['presentation_report'],
  })
  assert.notEqual(
    before.skills[0].instructions,
    'New instructions for new conversations.',
  )
  await f.resources.assertActive(
    f.admin.userId,
    [],
    [selected.id],
    ['knowledge_search'],
  )
  await assert.rejects(
    f.resources.resolve(
      f.admin.userId,
      [],
      [selected.id],
      ['knowledge_search'],
    ),
    (error) => error.status === 422,
  )
  const current = (await f.resources.catalog(f.admin)).skills.find(
    (item) => item.id === selected.id,
  )
  await f.request(`/admin/skills/${selected.id}`, 'PUT', {
    ...current,
    enabled: false,
  })
  await assert.rejects(
    f.resources.assertActive(
      f.admin.userId,
      [],
      [selected.id],
      ['knowledge_search'],
    ),
    (error) => error.status === 403,
  )
})

test('v2_40 resources migration preserves legacy agents and custom menus and adds each resource menu once', async (t) => {
  const f = await fixture(t)
  const asset = await f.asset()
  const beforeUser = (
    await f.db.query('SELECT * FROM users WHERE id=$1', [f.admin.userId])
  )[0]
  const now = new Date().toISOString()
  const legacy = {
    id: 'legacy-agent',
    knowledgeAssetIds: [asset.id],
    skillIds: ['company-knowledge'],
    toolIds: ['knowledge_search'],
  }
  await f.db.query(
    'INSERT INTO business_agents(id,owner_user_id,name,version,published,definition_json,created_at,updated_at) VALUES($1,$2,$3,1,1,$4,$5,$5)',
    [legacy.id, f.admin.userId, 'Legacy agent', JSON.stringify(legacy), now],
  )
  const existing = defaultMenuItems()
    .filter((item) => !['knowledge', 'skills', 'tools'].includes(item.id))
    .map((item) =>
      item.id === 'agents'
        ? { ...item, title: 'Custom agents', visible: false }
        : item,
    )
  await f.db.query(
    "INSERT INTO navigation_settings(id,version,items_json,updated_at) VALUES('global',9,$1,$2)",
    [JSON.stringify(existing), now],
  )
  for (const table of [
    'business_knowledge_bases',
    'business_agent_skills',
    'business_agent_tools',
  ])
    await f.db.query(`DROP TABLE ${table}`)
  await f.db.query("UPDATE alembic_version SET version_num='v2_40'")
  await ensureSchema(f.db)
  await ensureSchema(f.db)
  assert.equal(
    (await f.db.query('SELECT version_num FROM alembic_version'))[0]
      .version_num,
    'v2_42',
  )
  assert.equal(
    (
      await f.db.query('SELECT password_hash FROM users WHERE id=$1', [
        f.admin.userId,
      ])
    )[0].password_hash,
    beforeUser.password_hash,
  )
  assert.deepEqual(
    JSON.parse(
      (
        await f.db.query(
          'SELECT definition_json FROM business_agents WHERE id=$1',
          [legacy.id],
        )
      )[0].definition_json,
    ),
    legacy,
  )
  assert.equal(
    (
      await f.db.query('SELECT sha256 FROM business_agent_assets WHERE id=$1', [
        asset.id,
      ])
    )[0].sha256,
    asset.sha256,
  )
  const settings = (
    await f.db.query("SELECT * FROM navigation_settings WHERE id='global'")
  )[0]
  assert.equal(settings.version, 10)
  const menus = JSON.parse(settings.items_json)
  assert.deepEqual(
    menus.find((item) => item.id === 'agents'),
    existing.find((item) => item.id === 'agents'),
  )
  for (const id of ['knowledge', 'skills', 'tools'])
    assert.equal(menus.filter((item) => item.id === id).length, 1)
})
