import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { withTestDatabase } from './support/database.mjs'
import { IdentityService } from '../identity/service.ts'
import { ConnectorHub } from '../devices/connector-hub.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { SkillRuntime } from '../skills/runtime.ts'
import { executeAgentTool } from '../agents/execution.ts'
import { documentSkillProgram } from '../../../desktop/core/src/client/skill-presets.ts'
import { ensureSchema } from '../infrastructure/schema.ts'

async function fixture(t) {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, {
    secret: 'synthetic-skills-secret',
  })
  await identity.seedBuiltinRoles()
  const account = await identity.createUser(
    {
      username: 'manager',
      password: 'synthetic-skill-password',
      displayName: '技能临时账号',
    },
    { role: 'admin' },
  )
  const other = await identity.createUser({
    username: 'other',
    password: 'synthetic-other-password',
    displayName: '另一账号',
  })
  const hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-skills-secret',
    authenticateToken: identity.authenticateToken.bind(identity),
    getUser: identity.getUser.bind(identity),
  })
  t.after(() => hub.close())
  const service = new BusinessAgentService({
    db,
    hub,
    files: { library: undefined },
    getAccount: identity.getUser.bind(identity),
    audit: identity.audit.bind(identity),
  })
  const resources = new AgentResourceService(service.options)
  await resources.ensureDefaults(account)
  const program = documentSkillProgram('ppt')
  program.stages[1].skillId = 'presentation-planning'
  const draft = await resources.saveSkill(account, {
    name: '阶段办公技能',
    description: '真实阶段约束',
    instructions: '遵循发布的阶段',
    enabled: true,
    requiredToolIds: ['presentation_report'],
    programDraft: program,
  })
  const skill = await resources.publishSkill(account, draft.id, draft.version)
  const definition = await service.save(account, {
    name: '办公助手',
    description: '用于隔离验证',
    instructions: '完成任务',
    knowledgeBaseIds: [],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [skill.id],
    toolIds: ['presentation_report'],
    published: true,
    skillPolicy: { mode: 'auto' },
  })
  const { connector } = await hub.store.createConnector(account.userId, {
    name: 'temporary',
  })
  await db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connector.id],
  )
  const sessionId = 'skill-session-' + randomUUID(),
    now = new Date().toISOString()
  await db.query(
    "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES($1,$2,'dsh','dsh','idle',1,1,1,$3,$3)",
    [sessionId, connector.id, now],
  )
  await service.bind(
    account,
    await hub.store.session(sessionId, account.userId),
    definition,
  )
  const binding = await service.binding(account.userId, sessionId)
  const runtime = new SkillRuntime(service)
  const context = {
    sessionId,
    presetId: binding.presetId,
    bindingVersion: binding.bindingVersion,
    callId: 'call-1',
    requestId: 'user-1',
    requestText: '制作一份培训 PPT',
  }
  const control = (args, changes = {}) =>
    executeAgentTool(
      service,
      account.userId,
      sessionId,
      'superdsh_skill',
      args,
      new AbortController().signal,
      { ...context, ...changes },
    )
  return {
    db,
    account,
    other,
    service,
    resources,
    skill,
    binding,
    runtime,
    context,
    control,
    sessionId,
  }
}

test('published snapshots, automatic matching and independent staged records enforce real tool evidence', async (t) => {
  const f = await fixture(t)
  const candidates = await f.control({ action: 'match' })
  assert.equal(candidates.candidates[0].id, f.skill.id)
  let state = await f.control({
    action: 'start',
    skillId: f.skill.id,
    reason: '用户要求演示文稿',
  })
  const id = state.run.id
  assert.equal(
    (
      await f.control({
        action: 'start',
        skillId: f.skill.id,
        reason: '重复请求',
      })
    ).run.id,
    id,
  )
  await assert.rejects(
    f.control({
      action: 'submit',
      runId: id,
      version: state.run.version,
      stageId: 'inspect',
      output: { sources: [] },
    }),
    /真实工具/,
  )
  await assert.rejects(
    f.runtime.beforeTool(f.account.userId, f.binding, 'presentation_report', {
      ...f.context,
      phase: 'execute',
    }),
    /仅允许/,
  )
  let ticket = await f.runtime.beforeTool(
    f.account.userId,
    f.binding,
    'presentation_report',
    { ...f.context, phase: 'inspect' },
  )
  await assert.rejects(
    f.runtime.beforeTool(f.account.userId, f.binding, 'presentation_report', {
      ...f.context,
      phase: 'inspect',
    }),
    /已有工具/,
  )
  await f.runtime.afterTool(f.account.userId, f.binding, ticket, {
    inspection: {},
    sources: [],
  })
  state = await f.control({ action: 'status' })
  assert.equal(state.currentStage.id, 'planning')
  assert.match(state.currentStage.instructions, /明确受众|确认受众/)
  const submit = async (output) =>
    f.control({
      action: 'submit',
      runId: id,
      version: state.run.version,
      stageId: state.currentStage.id,
      output,
    })
  state = await submit({ summary: '太短' })
  assert.equal(state.run.state, 'needs-revision')
  state = await submit({
    summary:
      '为企业员工制作培训演示，明确课程目的，按三个知识主题和行动清单安排页面。',
  })
  await assert.rejects(
    f.control({
      action: 'submit',
      runId: id,
      version: 1,
      stageId: 'layout',
      output: {},
    }),
    /阶段已变化/,
  )
  state = await submit({
    summary:
      '采用中文宽屏版式，标题与正文原生可编辑，流程用原生形状，控制字号与边距。',
  })
  assert.equal(state.currentStage.id, 'plan')
  ticket = await f.runtime.beforeTool(
    f.account.userId,
    f.binding,
    'presentation_report',
    { ...f.context, phase: 'prepare' },
  )
  await f.runtime.afterTool(f.account.userId, f.binding, ticket, {
    plan: { id: 'plan-real', sha256: 'verified' },
    confirmation: { token: 'must-not-leak' },
  })
  state = await f.control({ action: 'status' })
  assert.equal(state.run.state, 'waiting-user')
  assert.equal(JSON.stringify(state).includes('must-not-leak'), false)
  await assert.rejects(
    f.runtime.beforeTool(f.account.userId, f.binding, 'presentation_report', {
      ...f.context,
      phase: 'execute',
      confirmation: { planId: 'old-plan' },
    }),
    /确认不属于/,
  )
  ticket = await f.runtime.beforeTool(
    f.account.userId,
    f.binding,
    'presentation_report',
    { ...f.context, phase: 'execute', confirmation: { planId: 'plan-real' } },
  )
  await f.db.query(
    'INSERT INTO business_agent_artifacts(id,session_id,metadata_json,created_at) VALUES($1,$2,$3,$4)',
    [
      'artifact-real',
      f.sessionId,
      JSON.stringify({
        fileId: 'artifact-real',
        quality: { status: 'passed' },
      }),
      new Date().toISOString(),
    ],
  )
  await f.runtime.afterTool(f.account.userId, f.binding, ticket, {
    artifact: { fileId: 'artifact-real' },
  })
  state = await f.control({ action: 'status' })
  state = await submit({
    summary:
      '已读取真实工具保存的成果及渲染检查报告，文件可下载，未声称进行视觉模型或 Office 客户端检查。',
  })
  assert.equal(state.run.state, 'completed')
  assert.equal(
    state.run.stages.every((stage) => stage.state === 'completed'),
    true,
  )
  assert.ok(state.run.stages.at(-1).checks.every((check) => check.passed))
  assert.equal((await f.runtime.list(f.account, f.sessionId)).items.length, 1)
  assert.equal((await f.runtime.read(f.account, f.sessionId, id)).run.id, id)
  await assert.rejects(f.runtime.read(f.other, f.sessionId, id))
  await assert.rejects(f.runtime.list(f.other, f.sessionId))
  assert.ok(
    (
      await f.db.query('SELECT id FROM agent_skill_events WHERE run_id=$1', [
        id,
      ])
    ).length >= 9,
  )
  await f.resources.saveSkill(
    f.account,
    { ...f.skill, instructions: '新配置', enabled: false },
    f.skill.id,
  )
  await assert.rejects(f.control({ action: 'match' }), /停用/)
})

test('revisions invalidate old confirmations; expired ownership interrupts without replay', async (t) => {
  const f = await fixture(t)
  let state = await f.control({
    action: 'start',
    skillId: f.skill.id,
    reason: 'PPT 任务',
  })
  const ticket = await f.runtime.beforeTool(
    f.account.userId,
    f.binding,
    'presentation_report',
    { ...f.context, phase: 'inspect' },
  )
  await f.db.query(
    "UPDATE agent_skill_runs SET claim_expires_at='2000-01-01T00:00:00Z' WHERE id=$1",
    [state.run.id],
  )
  state = await f.control({ action: 'status' })
  assert.equal(state.run.state, 'interrupted')
  await assert.rejects(
    f.runtime.afterTool(f.account.userId, f.binding, ticket, { sources: [] }),
    /归属失效/,
  )
  await assert.rejects(
    f.control({
      action: 'revise',
      runId: state.run.id,
      version: state.run.version,
      stageId: 'inspect',
    }),
    /新的明确请求/,
  )
  state = await f.control(
    {
      action: 'revise',
      runId: state.run.id,
      version: state.run.version,
      stageId: 'inspect',
    },
    { requestId: 'user-2', requestText: '请重新检查后继续' },
  )
  assert.equal(state.run.revision, 2)
  assert.equal(state.run.history[0].state, 'interrupted')
  assert.equal(state.run.stages[0].attempt, 2)
  await f.runtime.recoverAfterRestart()
  state = await f.control({ action: 'status' })
  assert.equal(state.run.state, 'interrupted')
  assert.match(state.run.stages[0].error, /重启/)
  const version = state.run.version
  await f.runtime.recoverAfterRestart()
  assert.equal((await f.control({ action: 'status' })).run.version, version)
  await assert.rejects(
    f.control(
      {
        action: 'revise',
        runId: state.run.id,
        version,
        stageId: 'inspect',
      },
      { requestId: 'user-2' },
    ),
    /新的明确请求/,
  )
})

test('v2_45 increment preserves existing accounts, bindings and configuration while adding skill records', async (t) => {
  const f = await fixture(t)
  await f.db.query(
    "INSERT INTO instance_settings(key,value,updated_at) VALUES('synthetic-model-credential','opaque-encrypted-test-value','2026-11-07T00:00:00Z')",
  )
  const before = await f.db.query('SELECT * FROM users ORDER BY id')
  const binding = await f.service.binding(f.account.userId, f.sessionId)
  await f.db.query('DROP TABLE agent_skill_events,agent_skill_runs')
  await f.db.query("UPDATE alembic_version SET version_num='v2_45'")
  await ensureSchema(f.db)
  assert.deepEqual(await f.db.query('SELECT * FROM users ORDER BY id'), before)
  assert.deepEqual(
    await f.service.binding(f.account.userId, f.sessionId),
    binding,
  )
  assert.equal(
    (
      await f.db.query(
        "SELECT value FROM instance_settings WHERE key='synthetic-model-credential'",
      )
    )[0].value,
    'opaque-encrypted-test-value',
  )
  assert.equal(
    (await f.db.query('SELECT version_num FROM alembic_version'))[0]
      .version_num,
    'v2_46',
  )
  assert.deepEqual(await f.db.query('SELECT id FROM agent_skill_runs'), [])
  await ensureSchema(f.db)
})

test('DSH turn settlement records incomplete and cancelled runs without inventing completion', async (t) => {
  const f = await fixture(t)
  await f.control({
    action: 'start',
    skillId: f.skill.id,
    reason: '用户要制作 PPT',
  })
  await f.runtime.settled(
    f.account.userId,
    { ...f.context, requestId: 'other-turn' },
    'aborted',
  )
  assert.equal((await f.control({ action: 'status' })).run.state, 'running')
  await f.runtime.settled(f.account.userId, f.context, 'completed')
  let state = await f.control({ action: 'status' })
  assert.equal(state.run.state, 'needs-revision')
  await f.control(
    {
      action: 'revise',
      runId: state.run.id,
      version: state.run.version,
      stageId: 'inspect',
    },
    { requestId: 'user-2' },
  )
  await f.runtime.settled(
    f.account.userId,
    { ...f.context, requestId: 'user-2' },
    'aborted',
  )
  state = await f.control({ action: 'status' })
  assert.equal(state.run.state, 'cancelled')
  assert.equal(state.run.history.length, 6)
  assert.equal(state.run.stages[0].calls.length, 0)
  await assert.rejects(
    f.control(
      {
        action: 'revise',
        runId: state.run.id,
        version: state.run.version,
        stageId: 'inspect',
      },
      { requestId: 'user-2' },
    ),
    /新的明确请求/,
  )
  await assert.rejects(
    f.control(
      { action: 'cancel', runId: state.run.id, version: state.run.version },
      { requestId: 'user-2' },
    ),
    /新的明确请求/,
  )
  state = await f.control(
    { action: 'cancel', runId: state.run.id, version: state.run.version },
    { requestId: 'user-3', requestText: '停止旧任务，开始新的 PPT' },
  )
  assert.equal(state.run.state, 'cancelled')
  const next = await f.control(
    { action: 'start', skillId: f.skill.id, reason: '用户明确开始新的 PPT' },
    { requestId: 'user-3', requestText: '停止旧任务，开始新的 PPT' },
  )
  assert.notEqual(next.run.id, state.run.id)
})
