import assert from 'node:assert/strict'
import test from 'node:test'
import { BusinessAgentService } from '../agents/service.ts'
import { registerBusinessAgentRoutes } from '../agents/routes.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { IdentityService } from '../identity/service.ts'
import { withTestDatabase } from './support/database.mjs'
import { presentationSkillIds } from '../agents/presentation-skills.ts'
import { previousPresentationExample } from '../agents/demo-definitions.ts'

async function fixture(t) {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, {
    secret: 'synthetic-business-seed-test-secret',
  })
  await identity.seedBuiltinRoles()
  const account = await identity.createUser(
    {
      username: 'seed-manager',
      displayName: 'Seed manager',
      password: 'synthetic-seed-manager-password',
    },
    { role: 'admin' },
  )
  const service = new BusinessAgentService({
    db,
    // Demo initialization must not access files or prepare an Agent runtime.
    hub: new Proxy(
      {},
      {
        get() {
          throw new Error('Demo initialization must not use the Connector hub')
        },
      },
    ),
    files: new Proxy(
      {},
      {
        get(_target, key) {
          // This fixture exercises the supported legacy DB-blob storage branch.
          if (key === 'library') return undefined
          throw new Error('Demo initialization must not write runtime files')
        },
      },
    ),
    getAccount: (id) => identity.getUser(id),
    audit: (...args) => identity.audit(...args),
  })
  const handlers = new Map()
  registerBusinessAgentRoutes(
    {
      add(method, path, handler) {
        handlers.set(`${method} ${path}`, handler)
      },
    },
    service,
  )
  const seed = handlers.get('POST /admin/agents/initialize')
  const legacySeed = handlers.get('POST /admin/agents/demo')
  assert.equal(typeof seed, 'function')
  assert.equal(typeof legacySeed, 'function')
  const state = async () => {
    const [row] = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM business_agents WHERE owner_user_id=$1) AS agents,
        (SELECT COUNT(*) FROM business_agent_assets WHERE owner_user_id=$1) AS assets,
        (SELECT COUNT(*) FROM business_knowledge_bases WHERE owner_user_id=$1) AS libraries,
        (SELECT COUNT(*) FROM business_agent_skills WHERE owner_user_id=$1) AS skills,
        (SELECT COUNT(*) FROM business_agent_tools WHERE owner_user_id=$1) AS tools,
        (SELECT COUNT(*) FROM instance_settings WHERE key IN ($2,$3)) AS markers,
        (SELECT COUNT(*) FROM identity_audit WHERE actor_id=$1 AND action LIKE 'agent.%') AS audits`,
      [
        account.userId,
        `business-agent-demo:${account.userId}`,
        `business-agent-resources:${account.userId}`,
      ],
    )
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    )
  }
  return {
    db,
    account,
    service,
    seed: () => seed({ account, body: {} }),
    legacySeed: () => legacySeed({ account, body: {} }),
    copyLatest: () => legacySeed({ account, body: { copyLatest: true } }),
    state,
  }
}

const emptyState = {
  agents: 0,
  assets: 0,
  libraries: 0,
  skills: 0,
  tools: 0,
  markers: 0,
  audits: 0,
}
const seededState = {
  agents: 4,
  assets: 4,
  libraries: 3,
  skills: 9,
  tools: 7,
  markers: 2,
  audits: 11,
}

test('PPT skill upgrade preserves edited and deleted skills, versions and customized assistants', async (t) => {
  const f = await fixture(t)
  const initial = await f.seed()
  const resources = new AgentResourceService(f.service.options)
  const ppt = initial.agents[1]
  const previous = await f.service.save(
    f.account,
    { ...ppt, ...previousPresentationExample, skillPolicy: { mode: 'legacy' } },
    ppt.id,
  )
  const catalog = await resources.catalog(f.account)
  const planning = catalog.skills.find(
    (skill) => skill.id === presentationSkillIds[0],
  )
  const custom = await resources.saveSkill(
    f.account,
    { ...planning, instructions: '公司的策划标准' },
    planning.id,
  )
  await resources.remove('skills', f.account, 'presentation-flow')
  await resources.remove('skills', f.account, presentationSkillIds[2])
  const markerKey = `business-agent-demo:${f.account.userId}`
  const [row] = await f.db.query(
    'SELECT value FROM instance_settings WHERE key=$1',
    [markerKey],
  )
  const marker = JSON.parse(row.value)
  marker.version = 5
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    markerKey,
    JSON.stringify(marker),
  ])
  await f.db.query('DELETE FROM instance_settings WHERE key=$1', [
    `business-agent-resources:${f.account.userId}:presentation-skills-v1`,
  ])
  const upgraded = await f.seed()
  assert.deepEqual(
    upgraded.agents.find((agent) => agent.id === ppt.id),
    previous,
    'deleted required skill prevents upgrade',
  )
  const after = await resources.catalog(f.account)
  assert.deepEqual(
    after.skills.find((skill) => skill.id === planning.id),
    custom,
  )
  assert.ok(
    !after.skills.some((skill) => skill.id === presentationSkillIds[2]),
    'deleted seed is not resurrected',
  )
  assert.equal(
    (
      await resources.history(
        'skills',
        f.account,
        planning.id,
        new URLSearchParams(),
      )
    ).total,
    2,
  )
  await assert.rejects(
    resources.assertActive(f.account.userId, [], [presentationSkillIds[2]], []),
    { status: 403 },
  )
})

test('untouched v5 PPT example adopts three skills once; edited example is preserved', async (t) => {
  const f = await fixture(t)
  const initial = await f.seed()
  const ppt = initial.agents[1]
  const previous = await f.service.save(
    f.account,
    { ...ppt, ...previousPresentationExample, skillPolicy: { mode: 'legacy' } },
    ppt.id,
  )
  const key = `business-agent-demo:${f.account.userId}`
  const [row] = await f.db.query(
    'SELECT value FROM instance_settings WHERE key=$1',
    [key],
  )
  const old = { ...JSON.parse(row.value), version: 5 }
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    key,
    JSON.stringify(old),
  ])
  const upgraded = (await f.seed()).agents.find((agent) => agent.id === ppt.id)
  assert.deepEqual(upgraded.skillIds, [
    'company-knowledge',
    ...presentationSkillIds,
  ])
  assert.equal(upgraded.version, previous.version + 1)
  assert.deepEqual(
    (await f.seed()).agents.find((agent) => agent.id === ppt.id),
    upgraded,
  )
  const custom = await f.service.save(
    f.account,
    {
      ...upgraded,
      ...previousPresentationExample,
      instructions: '公司定制演示流程',
    },
    ppt.id,
  )
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    key,
    JSON.stringify(old),
  ])
  assert.deepEqual(
    (await f.seed()).agents.find((agent) => agent.id === ppt.id),
    custom,
  )
})

for (const failureAt of [2, 3]) {
  test(`demo seed rolls back assets, agents, audits and marker when Agent insert ${failureAt} fails, then retries once`, async (t) => {
    const f = await fixture(t)
    // PostgreSQL sequences intentionally survive rollback, making this a
    // one-time database failure rather than a mock of transaction behavior.
    await f.db.query('CREATE SEQUENCE synthetic_seed_insert_attempt')
    await f.db.query(`
      CREATE FUNCTION synthetic_seed_failure() RETURNS trigger AS $$
      DECLARE agent_count bigint; asset_count bigint; audit_count bigint;
      BEGIN
        IF nextval('synthetic_seed_insert_attempt') = ${failureAt} THEN
          SELECT COUNT(*) INTO agent_count FROM business_agents;
          SELECT COUNT(*) INTO asset_count FROM business_agent_assets;
          SELECT COUNT(*) INTO audit_count FROM identity_audit WHERE action LIKE 'agent.%';
          RAISE EXCEPTION 'synthetic seed failure: agents=%, assets=%, audits=%',
            agent_count, asset_count, audit_count;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_seed_failure BEFORE INSERT ON business_agents
        FOR EACH ROW EXECUTE FUNCTION synthetic_seed_failure();
    `)

    assert.deepEqual(await f.state(), emptyState)
    await assert.rejects(f.seed(), {
      message: `synthetic seed failure: agents=${failureAt - 1}, assets=4, audits=${failureAt + 6}`,
    })
    assert.deepEqual(
      await f.state(),
      emptyState,
      'all writes before the failed insert must roll back together',
    )

    const successful = await f.seed()
    assert.equal(successful.agents.length, 4)
    assert.equal(successful.assets.length, 4)
    assert.equal(successful.knowledgeBases.length, 3)
    assert.equal(new Set(successful.agents.map((item) => item.id)).size, 4)
    assert.equal(new Set(successful.assets.map((item) => item.id)).size, 4)
    assert.deepEqual(await f.state(), seededState)

    const repeated = await f.seed()
    assert.deepEqual(repeated, successful)
    assert.deepEqual(await f.state(), seededState)
    assert.deepEqual(await f.legacySeed(), successful)
    assert.equal(
      Number(
        (
          await f.db.query(
            'SELECT last_value FROM synthetic_seed_insert_attempt',
          )
        )[0].last_value,
      ),
      failureAt + 4,
      'retry after success must return the committed marker without inserting',
    )
    assert.equal((await f.db.query('SELECT * FROM server_agents')).length, 0)
  })
}

test('initial page preparation persists four editable examples and never recreates intentionally removed resources', async (t) => {
  const f = await fixture(t)
  const initial = await f.seed()
  assert.deepEqual(
    initial.agents.map((item) => item.name),
    ['Excel 办公助手', 'PPT 演示助手', '企业知识助手', 'Word 文档助手'],
  )
  assert.ok(
    initial.agents.every(
      (item) =>
        item.recommendedPrompts.length &&
        item.inputRequirements.length &&
        item.outputExamples.length,
    ),
  )
  assert.deepEqual(await f.state(), seededState)
  const catalog = await f.service.catalog(f.account)
  assert.equal(catalog.skills.length, 9)
  for (const index of [1, 3]) {
    const definition = initial.agents[index]
    assert.equal(definition.skillPolicy.mode, 'auto')
    assert.equal(
      catalog.skills.find((skill) => skill.id === definition.skillIds[0])
        .program.stages.length,
      6,
    )
  }
  assert.equal(catalog.tools.length, 7)
  assert.deepEqual(
    initial.agents.map((agent) => agent.knowledgeBaseIds.length),
    [2, 2, 1, 1],
  )
  for (const agent of initial.agents) {
    assert.equal(agent.published, true)
    assert.ok(
      agent.knowledgeBaseIds.every((id) =>
        catalog.knowledgeBases.some((item) => item.id === id),
      ),
    )
  }
  const removed = initial.agents[1]
  const libraryId = removed.knowledgeBaseIds[1]
  await f.service.remove(f.account, removed.id)
  await new AgentResourceService(f.service.options).remove(
    'knowledge-bases',
    f.account,
    libraryId,
  )
  const next = await f.seed()
  assert.equal(next.agents.length, 3)
  assert.equal(next.knowledgeBases.length, 2)
  assert.equal(
    next.agents.some((item) => item.id === removed.id),
    false,
  )
  assert.equal(
    (await f.state()).agents,
    4,
    'soft-deleted examples must never be inserted again',
  )
  assert.equal((await f.db.query('SELECT * FROM server_agents')).length, 0)
})

test('copying updated examples creates separate unpublished records once without overwriting custom or deleted originals', async (t) => {
  const f = await fixture(t)
  const initial = await f.seed()
  const custom = await f.service.save(
    f.account,
    {
      ...initial.agents[0],
      name: '公司自己的办公助手',
      instructions: '企业定制规则，不覆盖。',
    },
    initial.agents[0].id,
  )
  await f.service.remove(f.account, initial.agents[1].id)
  await f.copyLatest()
  const listed = await f.service.list(
    f.account,
    new URLSearchParams({ pageSize: '100' }),
    true,
  )
  assert.equal(listed.total, 7)
  const copies = listed.items.filter((item) => item.name.endsWith('新版副本'))
  assert.equal(copies.length, 4)
  assert.ok(copies.every((item) => !item.published))
  assert.ok(
    copies.every((item) =>
      item.skillIds.every(
        (id) =>
          ![
            'sales-analysis',
            'company-knowledge',
            'business-presentation',
          ].includes(id),
      ),
    ),
  )
  assert.deepEqual(
    listed.items.find((item) => item.id === custom.id),
    custom,
  )
  const before = await f.state()
  await f.copyLatest()
  assert.deepEqual(await f.state(), before)
})

test('legacy demo marker upgrades resource associations without recreating deleted Agents or overwriting customized definitions', async (t) => {
  const f = await fixture(t)
  const original = await f.seed()
  const legacy = original.agents.map((agent, index) => {
    const { knowledgeBaseIds: _knowledgeBaseIds, ...entry } = agent
    return {
      ...entry,
      knowledgeAssetIds: original.assets.slice(0, 2).map((item) => item.id),
      templateAssetIds: index < 2 ? [original.assets[index + 2].id] : [],
    }
  })
  for (const agent of legacy) {
    await f.db.query(
      'UPDATE business_agents SET name=$2,definition_json=$3 WHERE id=$1',
      [
        agent.id,
        `${agent.name}（我的定制）`,
        JSON.stringify({
          ...agent,
          name: `${agent.name}（我的定制）`,
          instructions: '保留企业自己的业务规则。',
        }),
      ],
    )
  }
  await f.service.remove(f.account, legacy[2].id)
  await f.db.query(
    'DELETE FROM business_knowledge_bases WHERE owner_user_id=$1',
    [f.account.userId],
  )
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    `business-agent-demo:${f.account.userId}`,
    JSON.stringify({ agents: legacy, assets: original.assets }),
  ])
  const upgraded = await f.seed()
  assert.equal(upgraded.agents.length, 3)
  assert.equal(upgraded.assets.length, 4)
  assert.equal(upgraded.knowledgeBases.length, 3)
  for (const agent of upgraded.agents) {
    assert.match(agent.name, /我的定制/)
    assert.equal(agent.instructions, '保留企业自己的业务规则。')
    assert.equal(
      agent.knowledgeBaseIds.length,
      agent.id === legacy[3].id ? 1 : 2,
    )
    assert.equal(agent.version, 2)
  }
  const before = await f.state()
  assert.deepEqual(await f.seed(), upgraded)
  assert.deepEqual(await f.state(), before)
})

test('legacy examples with a deliberately disabled tool do not block resource management or re-enable that tool', async (t) => {
  const f = await fixture(t)
  const original = await f.seed()
  const legacy = original.agents.map(
    ({ knowledgeBaseIds: _knowledgeBaseIds, ...agent }) => agent,
  )
  for (const agent of legacy)
    await f.db.query(
      'UPDATE business_agents SET definition_json=$2 WHERE id=$1',
      [agent.id, JSON.stringify(agent)],
    )
  await f.db.query(
    'DELETE FROM business_knowledge_bases WHERE owner_user_id=$1',
    [f.account.userId],
  )
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    `business-agent-demo:${f.account.userId}`,
    JSON.stringify({ agents: legacy, assets: original.assets }),
  ])
  const resources = new AgentResourceService(f.service.options)
  const tool = (await resources.catalog(f.account)).tools.find(
    (item) => item.id === 'presentation_report',
  )
  await resources.saveTool(f.account, { ...tool, enabled: false }, tool.id)
  const upgraded = await f.seed()
  assert.equal(upgraded.agents.length, 4)
  assert.equal(upgraded.knowledgeBases.length, 3)
  const preserved = upgraded.agents.find((item) => item.id === legacy[1].id)
  assert.equal(preserved.version, 1)
  assert.equal(preserved.knowledgeBaseIds, undefined)
  const disabled = (await resources.catalog(f.account)).tools.find(
    (item) => item.id === tool.id,
  )
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.version, 2)
  assert.deepEqual(await f.seed(), upgraded)
})
