import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { withTestDatabase } from './support/database.mjs'
import { IdentityService } from '../identity/service.ts'
import { ConnectorHub } from '../devices/connector-hub.ts'
import { FileService } from '../files/service.ts'
import { FileLibrary } from '../files/file-library.ts'
import { StorageRegistry } from '../files/storage-registry.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { OfficePlanService } from '../agents/office-plans.ts'
import { executeAgentTool } from '../agents/execution.ts'
import { registerBusinessAgentRoutes } from '../agents/routes.ts'
import { ApiError } from '../http/api-router.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { knowledgeChunks } from '../agents/knowledge-index.ts'

const document = (title = '报销统计') => ({
  title,
  sheets: [
    {
      name: '费用明细',
      source: {
        columns: ['人员', '交通', '餐费'],
        rows: [['示例员工', 0.1, 0.2]],
      },
      operations: [
        {
          type: 'formula',
          column: '合计',
          expression: {
            op: '+',
            left: { column: '交通' },
            right: { column: '餐费' },
          },
        },
      ],
    },
  ],
})

async function fixture(t, unifiedFiles = false) {
  let closeDb
  const db = await withTestDatabase({
    after(fn) {
      closeDb = fn
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-office-plans-'))
  const identity = new IdentityService(db, {
    secret: 'synthetic-office-plan-secret',
  })
  await identity.seedBuiltinRoles()
  const manager = await identity.createUser(
    {
      username: 'manager',
      displayName: 'Manager',
      password: 'synthetic-manager-password',
    },
    { role: 'admin' },
  )
  const member = await identity.createUser({
    username: 'member',
    displayName: 'Member',
    password: 'synthetic-member-password',
  })
  const hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-office-plan-secret',
    authenticateToken: identity.authenticateToken.bind(identity),
    getUser: identity.getUser.bind(identity),
  })
  const files = new FileService(hub, directory)
  let registry
  if (unifiedFiles) {
    registry = new StorageRegistry({
      db,
      root: join(directory, 'objects'),
      encryptionKey: randomBytes(32).toString('base64url'),
      environment: {},
    })
    files.library = new FileLibrary({
      db,
      registry,
      stagingDirectory: join(directory, 'uploads'),
    })
  }
  t.after(async () => {
    await files.close()
    registry?.close()
    await hub.close()
    await closeDb()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.includes('superdsh-office-plans-'))
    await rm(directory, { recursive: true, force: true })
  })
  const service = new BusinessAgentService({
    db,
    hub,
    files,
    getAccount: identity.getUser.bind(identity),
    audit: identity.audit.bind(identity),
  })
  const definition = await service.save(manager, {
    name: '办公助手',
    description: 'Synthetic trial',
    instructions: 'Check inputs and ask user before generating.',
    knowledgeBaseIds: [],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [],
    toolIds: ['spreadsheet_report', 'presentation_report'],
    published: true,
  })
  const { connector } = await hub.store.createConnector(member.userId, {
    name: 'Synthetic runtime',
  })
  await db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connector.id],
  )
  const sessionId = `office-${randomUUID()}`
  await db.query(
    "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES($1,$2,'dsh','dsh','idle',1,1,1,$3,$3)",
    [sessionId, connector.id, new Date().toISOString()],
  )
  await service.bind(
    member,
    await hub.store.session(sessionId, member.userId),
    definition,
  )
  const binding = await service.binding(member.userId, sessionId)
  const plans = new OfficePlanService(service)
  const context = {
    sessionId,
    presetId: binding.presetId,
    callId: randomUUID(),
    phase: 'prepare',
  }
  const invoke = (
    args,
    metadata = context,
    owner = member.userId,
    signal = new AbortController().signal,
  ) =>
    executeAgentTool(
      service,
      owner,
      sessionId,
      'spreadsheet_report',
      args,
      signal,
      metadata,
    )
  const prepare = (plan = document(), args = {}) =>
    invoke({ planJson: JSON.stringify(plan), ...args })
  return {
    db,
    identity,
    manager,
    member,
    service,
    files,
    sessionId,
    plans,
    context,
    prepare,
    invoke,
    definition,
  }
}

// A real minimal PDF for cache/authorization tests, intentionally not a visual-quality fixture.
function syntheticPdf(missingFonts = ['FixtureFont']) {
  const stream = 'BT /F1 18 Tf 30 100 Td (Test fixture) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += index + 1 + ' 0 obj\n' + value + '\nendobj\n'
  }
  const xref = Buffer.byteLength(pdf)
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((value) => String(value).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF'
  return {
    name: '脱敏演示.pdf',
    mediaType: 'application/pdf',
    contentBase64: Buffer.from(pdf).toString('base64'),
    missingFonts,
  }
}

async function presentationExecution(f, signal = new AbortController().signal) {
  const invoke = (args, context) =>
    executeAgentTool(
      f.service,
      f.member.userId,
      f.sessionId,
      'presentation_report',
      args,
      signal,
      context,
    )
  const prepared = await invoke(
    {
      planJson: JSON.stringify({
        title: '脱敏演示',
        slides: [
          {
            id: 'intro',
            kind: 'title',
            title: '公司介绍',
            body: ['测试资料，无真实企业数据。'],
          },
        ],
      }),
    },
    f.context,
  )
  const context = {
    ...f.context,
    phase: 'execute',
    confirmation: prepared.confirmation,
  }
  return { prepared, invoke: () => invoke({}, context) }
}

function previewRoute(f) {
  let handler
  registerBusinessAgentRoutes(
    {
      add(method, path, callback) {
        if (
          method === 'GET' &&
          path ===
            '/sessions/{session_id}/agent-artifacts/{artifact_id}/preview'
        )
          handler = callback
      },
    },
    f.service,
  )
  assert.equal(typeof handler, 'function')
  return (fileId, account = f.member, signal = new AbortController().signal) =>
    handler({
      account,
      signal,
      params: { session_id: f.sessionId, artifact_id: fileId },
    })
}

test('only attested confirmation generates; concurrent duplicate confirmations commit one exact workbook', async (t) => {
  const f = await fixture(t)
  const prepared = await f.prepare()
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    0,
  )
  await assert.rejects(
    f.invoke(
      { approved: true, confirmation: prepared.confirmation },
      { ...f.context, phase: 'execute' },
    ),
    /确认/,
  )
  const publicPlan = await f.plans.read(f.member, f.sessionId, prepared.plan.id)
  assert.ok(!JSON.stringify(publicPlan).includes(prepared.confirmation.token))
  const execution = {
    ...f.context,
    phase: 'execute',
    confirmation: prepared.confirmation,
  }
  const completed = await Promise.all(
    Array.from({ length: 20 }, () => f.invoke({}, execution)),
  )
  const a = completed[0]
  assert.ok(
    completed.every((item) => item.artifact.fileId === a.artifact.fileId),
  )
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    1,
  )
  const file = await f.files.read(f.sessionId, a.artifact.fileId)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(file.data)
  assert.equal(
    workbook.getWorksheet('费用明细').getCell('D2').value.result,
    0.3,
  )
  assert.equal(a.artifact.revision.planHash, prepared.plan.sha256)
})

test('switching assistants retains evidence from its original binding and revoked sources disappear', async (t) => {
  const f = await fixture(t)
  const asset = await f.service.upload(f.manager, {
    name: 'policy.md',
    kind: 'knowledge',
    contentBase64:
      Buffer.from('公司资料必须确认授权后才可使用。').toString('base64'),
  })
  const resources = new AgentResourceService(f.service.options)
  const library = await resources.saveKnowledge(f.manager, {
    name: '制度',
    description: '',
    enabled: true,
    assetIds: [asset.id],
  })
  const withKnowledge = await f.service.save(
    f.manager,
    { ...f.definition, knowledgeBaseIds: [library.id] },
    f.definition.id,
  )
  const session = await f.service.options.hub.store.session(
    f.sessionId,
    f.member.userId,
  )
  await f.service.bind(f.member, session, withKnowledge, 1)
  const [row] = await f.db.query(
    'SELECT * FROM business_agent_assets WHERE id=$1',
    [asset.id],
  )
  const source = {
    ...knowledgeChunks(row)[0],
    id: 'preserved-evidence',
    bindingVersion: 2,
  }
  await f.db.query(
    'INSERT INTO business_agent_evidence(id,owner_user_id,session_id,source_json,created_at) VALUES($1,$2,$3,$4,$5)',
    [
      source.id,
      f.member.userId,
      f.sessionId,
      JSON.stringify(source),
      new Date().toISOString(),
    ],
  )
  const withoutKnowledge = await f.service.save(
    f.manager,
    { ...withKnowledge, knowledgeBaseIds: [] },
    f.definition.id,
  )
  await f.service.bind(f.member, session, withoutKnowledge, 2)
  let handler
  registerBusinessAgentRoutes(
    {
      add(method, path, value) {
        if (
          method === 'GET' &&
          path === '/sessions/{session_id}/agent-evidence/{evidence_id}'
        )
          handler = value
      },
    },
    f.service,
  )
  const request = (account) =>
    handler({
      account,
      params: { session_id: f.sessionId, evidence_id: source.id },
      url: new URL('http://fixture'),
    })
  assert.equal((await request(f.member)).source.content, source.content)
  await assert.rejects(request(f.manager), (error) => error.status === 404)
  await resources.saveKnowledge(
    f.manager,
    { ...library, enabled: false },
    library.id,
  )
  await assert.rejects(request(f.member), (error) => error.status === 404)
})

test('plan edits invalidate old approvals and preserve completed artifact revisions', async (t) => {
  const f = await fixture(t, true)
  const prepared = await f.prepare()
  await f.plans.revise(
    f.member,
    f.sessionId,
    prepared.plan.id,
    { version: prepared.plan.version, document: document('修改后的报销统计') },
    new AbortController().signal,
  )
  await assert.rejects(
    f.invoke(
      {},
      { ...f.context, phase: 'execute', confirmation: prepared.confirmation },
    ),
    /方案已改变/,
  )
  const next = await f.prepare(document('修改后的报销统计'))
  const first = await f.invoke(
    {},
    { ...f.context, phase: 'execute', confirmation: next.confirmation },
  )
  const revisedContext = { ...f.context, callId: randomUUID() }
  const revision = await f.invoke(
    {
      planJson: JSON.stringify(document('再次修改')),
      previousArtifactId: first.artifact.fileId,
    },
    revisedContext,
  )
  const second = await f.invoke(
    {},
    {
      ...revisedContext,
      phase: 'execute',
      confirmation: revision.confirmation,
    },
  )
  assert.notEqual(first.artifact.fileId, second.artifact.fileId)
  assert.equal(
    second.artifact.revision.previousArtifactId,
    first.artifact.fileId,
  )
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    2,
  )
  assert.ok(
    (await f.files.read(f.sessionId, first.artifact.fileId)).data.length > 0,
  )
  const oldEntry = await f.files.library.legacy(
    'session',
    f.sessionId,
    first.artifact.fileId,
  )
  const newEntry = await f.files.library.legacy(
    'session',
    f.sessionId,
    second.artifact.fileId,
  )
  const revisionEntry = await f.files.library.entry(
    f.member.userId,
    newEntry.file_id,
  )
  assert.equal(revisionEntry.version, 2)
  assert.equal(revisionEntry.previousFileId, oldEntry.file_id)
  await assert.rejects(
    f.files.library.entry(f.manager.userId, newEntry.file_id),
    /无权/,
  )
})

test('account isolation and permission revocation defeat old approvals and public plan reads', async (t) => {
  const f = await fixture(t)
  const prepared = await f.prepare()
  await assert.rejects(
    f.plans.read(f.manager, f.sessionId, prepared.plan.id),
    (error) => error.status === 404,
  )
  await assert.rejects(
    f.invoke(
      {},
      { ...f.context, phase: 'execute', confirmation: prepared.confirmation },
      f.manager.userId,
    ),
    (error) => error.status === 404,
  )
  await f.db.query('UPDATE users SET disabled=1 WHERE id=$1', [f.member.userId])
  await assert.rejects(
    f.invoke(
      {},
      { ...f.context, phase: 'execute', confirmation: prepared.confirmation },
    ),
  )
  assert.equal(
    (await f.db.query('SELECT * FROM business_agent_artifacts')).length,
    0,
  )
})

test('failed metadata commit requires a fresh approval before retrying', async (t) => {
  const f = await fixture(t)
  const prepared = await f.prepare()
  await f.db.query(`CREATE SEQUENCE synthetic_artifact_attempt;
    CREATE FUNCTION synthetic_artifact_failure() RETURNS trigger AS $$ BEGIN
      IF nextval('synthetic_artifact_attempt')=1 THEN RAISE EXCEPTION 'synthetic commit failure'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER synthetic_artifact_failure BEFORE INSERT ON business_agent_artifacts FOR EACH ROW EXECUTE FUNCTION synthetic_artifact_failure();`)
  const execution = {
    ...f.context,
    phase: 'execute',
    confirmation: prepared.confirmation,
  }
  await assert.rejects(f.invoke({}, execution), /synthetic commit failure/)
  assert.equal(
    (await f.plans.read(f.member, f.sessionId, prepared.plan.id)).state,
    'failed',
  )
  assert.equal(
    (await f.db.query('SELECT * FROM business_agent_artifacts')).length,
    0,
  )
  await assert.rejects(f.invoke({}, execution), (error) => error.status === 409)
  const renewed = await f.prepare()
  const recovered = await f.invoke(
    {},
    { ...execution, confirmation: renewed.confirmation },
  )
  assert.ok(recovered.artifact.fileId)
  assert.equal(
    (await f.db.query('SELECT * FROM business_agent_artifacts')).length,
    1,
  )
  assert.equal(
    (await f.plans.read(f.member, f.sessionId, prepared.plan.id)).state,
    'completed',
  )
})

test('cancellation and malformed inputs cannot silently generate demo artifacts', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.prepare({
      title: 'Invalid',
      sheets: [{ name: 'sheet', source: 'missing:table' }],
    }),
    /找不到/,
  )
  await assert.rejects(
    f.prepare(document(), {
      inputsJson: JSON.stringify([{ assetId: 'some-other-user-file' }]),
    }),
    /未授权/,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    f.invoke(
      { planJson: JSON.stringify(document()) },
      f.context,
      f.member.userId,
      controller.signal,
    ),
  )
  assert.equal(
    (await f.db.query('SELECT * FROM business_agent_artifacts')).length,
    0,
  )
})

test(
  'a revision prepared before generation commits cannot overwrite the completed plan',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t)
    const prepared = await f.prepare()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const query = f.db.query.bind(f.db)
    let held = false
    f.db.query = async (sql, values) => {
      if (
        !held &&
        sql.startsWith('UPDATE business_office_plans SET version=')
      ) {
        held = true
        entered.resolve()
        await release.promise
      }
      return query(sql, values)
    }
    const revision = f.plans.revise(
      f.member,
      f.sessionId,
      prepared.plan.id,
      { version: prepared.plan.version, document: document('尚未批准的修改') },
      new AbortController().signal,
    )
    const rejected = assert.rejects(revision, (error) => error.status === 409)
    try {
      await entered.promise
      const completed = await f.invoke(
        {},
        { ...f.context, phase: 'execute', confirmation: prepared.confirmation },
      )
      release.resolve()
      await rejected
      const current = await f.plans.read(
        f.member,
        f.sessionId,
        prepared.plan.id,
      )
      assert.equal(current.state, 'completed')
      assert.equal(current.title, '报销统计')
      assert.equal(current.version, prepared.plan.version)
      assert.equal(current.artifactId, completed.artifact.fileId)
      assert.equal(
        (await f.service.artifacts(f.member, f.sessionId)).items.length,
        1,
      )
    } finally {
      release.resolve()
      await rejected.catch(() => {})
      f.db.query = query
    }
  },
)

test(
  'expired execution ownership prevents a late result from overwriting interrupted state',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t)
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers()
    f.service.options.renderOfficePreview = async () => {
      entered.resolve()
      await release.promise
      return syntheticPdf()
    }
    const execution = await presentationExecution(f)
    const pending = execution.invoke()
    const rejected = assert.rejects(pending, (error) => error.status === 409)
    await entered.promise
    await f.db.query(
      "UPDATE agent_tool_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE session_id=$1",
      [f.sessionId],
    )
    const interrupted = await f.plans.read(
      f.member,
      f.sessionId,
      execution.prepared.plan.id,
    )
    assert.equal(interrupted.state, 'interrupted')
    release.resolve()
    await rejected
    assert.equal(
      (await f.plans.read(f.member, f.sessionId, interrupted.id)).state,
      'interrupted',
    )
    assert.equal(
      (await f.service.artifacts(f.member, f.sessionId)).items.length,
      0,
    )
    await assert.rejects(execution.invoke(), (error) => error.status === 409)
  },
)

test('PPT execution renders once and returns a hash-bound cached PDF with missing-font diagnostics', async (t) => {
  const f = await fixture(t)
  let renders = 0
  f.service.options.renderOfficePreview = async (file) => {
    renders += 1
    assert.ok(file.filename.endsWith('.pptx'))
    assert.equal(file.content.subarray(0, 2).toString(), 'PK')
    return syntheticPdf(['缺失品牌字体'])
  }
  const execution = await presentationExecution(f)
  const result = await execution.invoke()
  assert.equal(result.artifact.preview.state, 'ready')
  assert.equal(result.artifact.preview.sourceSha256, result.artifact.sha256)
  assert.equal(result.artifact.preview.ownerUserId, f.member.userId)
  assert.equal(result.artifact.preview.sessionId, f.sessionId)
  assert.match(result.artifact.diagnostics.join(' '), /缺失品牌字体/u)
  const route = previewRoute(f)
  const first = await route(result.artifact.fileId)
  const second = await route(result.artifact.fileId)
  assert.deepEqual(first, syntheticPdf(['缺失品牌字体']))
  assert.deepEqual(first, second)
  assert.equal(renders, 1)
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    1,
  )
  await assert.rejects(
    route(result.artifact.fileId, f.manager),
    (error) => error.status === 404,
  )
  await f.db.query('UPDATE users SET disabled=1 WHERE id=$1', [f.member.userId])
  await assert.rejects(route(result.artifact.fileId))
  assert.equal(renders, 1)
})

test('a failed PPT render preserves the editable artifact, persists timeout diagnostics, and the preview route retries', async (t) => {
  const f = await fixture(t)
  f.service.options.renderOfficePreview = async () => {
    throw new ApiError(504, '文档预览生成超时')
  }
  const execution = await presentationExecution(f)
  const result = await execution.invoke()
  assert.equal(result.artifact.preview.state, 'failed')
  assert.equal(result.artifact.preview.errorStatus, 504)
  assert.match(result.note, /渲染检查未通过/u)
  assert.match(result.artifact.diagnostics.join(' '), /超时.*重试/u)
  assert.equal(
    (await f.plans.read(f.member, f.sessionId, execution.prepared.plan.id))
      .state,
    'completed',
  )
  assert.ok(
    (await f.files.read(f.sessionId, result.artifact.fileId)).data.length > 0,
  )
  const route = previewRoute(f)
  await assert.rejects(
    route(result.artifact.fileId),
    (error) => error.status === 504 && !error.message.includes('取消'),
  )
  f.service.options.renderOfficePreview = async () => syntheticPdf()
  assert.deepEqual(await route(result.artifact.fileId), syntheticPdf())
  const updated = (await f.service.artifacts(f.member, f.sessionId)).items[0]
  assert.equal(updated.preview.state, 'ready')
  assert.ok(
    !updated.diagnostics.some((item) => item.startsWith('预览验证：失败')),
  )
  assert.equal(updated.fileId, result.artifact.fileId)
})

test('cached preview ownership and source hash are verified before returning bytes', async (t) => {
  const f = await fixture(t)
  let renders = 0
  f.service.options.renderOfficePreview = async () => {
    renders += 1
    return syntheticPdf()
  }
  const result = await (await presentationExecution(f)).invoke()
  const metadata = structuredClone(result.artifact)
  metadata.preview.ownerUserId = f.manager.userId
  await f.db.query(
    'UPDATE business_agent_artifacts SET metadata_json=$2 WHERE id=$1',
    [metadata.fileId, JSON.stringify(metadata)],
  )
  await previewRoute(f)(metadata.fileId)
  assert.equal(
    renders,
    2,
    'an unrelated cached owner cannot authorize a cache hit',
  )
  const file = await f.files.read(f.sessionId, metadata.fileId)
  await f.files.save(
    f.member.userId,
    f.sessionId,
    file.metadata.name,
    Buffer.from('changed source artifact'),
    file.metadata.mediaType,
    metadata.fileId,
  )
  await assert.rejects(
    previewRoute(f)(metadata.fileId),
    (error) => error.status === 409,
  )
  assert.equal(
    renders,
    2,
    'a changed source must not silently inherit the previous preview',
  )
})

test('cancellation during PPT rendering does not commit a completed artifact', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.service.options.renderOfficePreview = async (_file, signal) => {
    controller.abort(new ApiError(499, '办公任务已取消'))
    signal.throwIfAborted()
    return syntheticPdf()
  }
  const execution = await presentationExecution(f, controller.signal)
  await assert.rejects(execution.invoke(), (error) => error.status === 499)
  assert.equal(
    (await f.plans.read(f.member, f.sessionId, execution.prepared.plan.id))
      .state,
    'cancelled',
  )
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    0,
  )
})

test('Excel execution does not use PDF rendering as its calculation check', async (t) => {
  const f = await fixture(t)
  f.service.options.renderOfficePreview = async () => {
    throw new Error('Excel generation must not render')
  }
  const prepared = await f.prepare()
  const result = await f.invoke(
    {},
    { ...f.context, phase: 'execute', confirmation: prepared.confirmation },
  )
  assert.equal(result.artifact.preview, undefined)
  const file = await f.files.read(f.sessionId, result.artifact.fileId)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(file.data)
  assert.equal(workbook.getWorksheet('费用明细').getCell('D2').result, 0.3)
})

test('a task deadline during PPT rendering remains timed-out, not user-cancelled', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.service.options.renderOfficePreview = async (_file, signal) => {
    controller.abort(new ApiError(504, '办公工具执行超时'))
    signal.throwIfAborted()
    return syntheticPdf()
  }
  const execution = await presentationExecution(f, controller.signal)
  await assert.rejects(execution.invoke(), (error) => error.status === 504)
  const plan = await f.plans.read(
    f.member,
    f.sessionId,
    execution.prepared.plan.id,
  )
  assert.equal(plan.state, 'timed-out')
  assert.match(plan.error, /超时/u)
  assert.equal(
    (await f.service.artifacts(f.member, f.sessionId)).items.length,
    0,
  )
})

test('permission revocation while PPT renders prevents artifact and preview publication', async (t) => {
  const f = await fixture(t)
  f.service.options.renderOfficePreview = async () => {
    await f.db.query('UPDATE users SET disabled=1 WHERE id=$1', [
      f.member.userId,
    ])
    return syntheticPdf()
  }
  const execution = await presentationExecution(f)
  await assert.rejects(execution.invoke())
  const [row] = await f.db.query(
    'SELECT plan_json FROM business_office_plans WHERE id=$1',
    [execution.prepared.plan.id],
  )
  assert.equal(JSON.parse(row.plan_json).state, 'failed')
  assert.equal(
    (await f.db.query('SELECT * FROM business_agent_artifacts')).length,
    0,
  )
})

test('generated bytes are downloadable only after their artifact commits and uploads cannot overwrite reserved IDs', async (t) => {
  const f = await fixture(t, true)
  const artifactId = `artifact_${'a'.repeat(40)}`
  const previewId = `preview_${'b'.repeat(40)}`
  const inputId = `office_input_${'c'.repeat(40)}`
  const originals = new Map([
    [artifactId, Buffer.from('synthetic editable artifact')],
    [previewId, Buffer.from(syntheticPdf().contentBase64, 'base64')],
    [inputId, Buffer.from('synthetic attested input')],
  ])
  let metadata
  for (const [fileId, data] of originals) {
    const saved = await f.files.save(
      f.member.userId,
      f.sessionId,
      fileId,
      data,
      'application/octet-stream',
      fileId,
    )
    if (fileId === artifactId) metadata = saved
  }
  for (const fileId of [artifactId, previewId])
    await assert.rejects(
      f.files.read(f.sessionId, fileId),
      (error) => error.status === 404,
      'uncommitted bytes must not be downloadable',
    )
  await f.db.query(
    'INSERT INTO business_agent_artifacts(id,session_id,metadata_json,created_at) VALUES($1,$2,$3,$4)',
    [
      artifactId,
      f.sessionId,
      JSON.stringify({
        ...metadata,
        preview: { state: 'ready', fileId: previewId },
      }),
      new Date().toISOString(),
    ],
  )
  for (const [fileId, data] of originals) {
    assert.deepEqual((await f.files.read(f.sessionId, fileId)).data, data)
    await assert.rejects(
      f.files.stage(f.member.userId, f.sessionId, [
        {
          fileId,
          name: 'replacement',
          contentBase64: Buffer.from('malicious replacement').toString(
            'base64',
          ),
        },
      ]),
      (error) => error.status === 422,
    )
    assert.deepEqual(
      (await f.files.read(f.sessionId, fileId)).data,
      data,
      'rejected uploads must preserve original bytes',
    )
  }
  await f.db.query('DELETE FROM business_agent_artifacts WHERE id=$1', [
    artifactId,
  ])
  for (const fileId of [artifactId, previewId])
    await assert.rejects(
      f.files.read(f.sessionId, fileId),
      (error) => error.status === 404,
      'deleting the committed artifact must revoke access to its leftover bytes',
    )
})
