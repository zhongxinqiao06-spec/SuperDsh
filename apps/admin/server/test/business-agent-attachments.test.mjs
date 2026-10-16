import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { readSalesAttachment } from '../agents/host-attachments.mjs'
import { BusinessHostChannel } from '../agents/host-channel.ts'
import { executeAgentTool } from '../agents/execution.ts'
import {
  parseAgentToolContext,
  decodeAgentAttachment,
} from '../agents/tool-context.ts'

const csv = Buffer.from(
  'orderId,date,region,product,quantity,unitPrice,unitCost\nN-1,2026-10-15,华东,产品甲,3,250,100\n',
)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const event = (bytes = csv, name = '销售台账.csv', seq = 2) => ({
  type: 'user/message',
  seq,
  data: {
    id: `message-${seq}`,
    source: { kind: 'user' },
    content: [
      {
        type: 'file',
        attachment: {
          name,
          bytes: bytes.length,
          attachmentId: `sha256:${hash(bytes)}`,
        },
      },
    ],
  },
})
function host(events, bytes = csv, controller = new AbortController()) {
  const reads = []
  return {
    execution: {
      agent: { session: { snapshotEvents: () => [...events] } },
      signal: controller.signal,
    },
    attachments: {
      async *readFileStream(ref, signal) {
        reads.push(ref)
        signal.throwIfAborted()
        yield bytes
      },
    },
    reads,
  }
}
async function attachedContext() {
  const fixture = host([event()])
  return {
    sessionId: 'session-one',
    presetId: 'business-one',
    callId: 'call-one',
    attachment: await readSalesAttachment(
      { attachmentName: '销售台账.csv' },
      fixture.execution,
      fixture.attachments,
    ),
  }
}

test('Host reads only accepted user file refs, preserves exact bytes, and supports bound-only mode', async () => {
  const queued = event(Buffer.from('unaccepted'), '尚未接收.csv', 3)
  const fixture = host([
    { type: 'agent/inbox/spliced', data: { inserted: [queued.data] } },
    event(),
  ])
  assert.equal(
    await readSalesAttachment({}, fixture.execution, fixture.attachments),
    undefined,
  )
  assert.equal(fixture.reads.length, 0)
  const result = await readSalesAttachment(
    { attachmentName: '销售台账.csv' },
    fixture.execution,
    fixture.attachments,
  )
  assert.equal(result.sourceMessageId, 'message-2')
  assert.equal(result.sha256, hash(csv))
  assert.deepEqual(Buffer.from(result.contentBase64, 'base64'), csv)
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '尚未接收.csv' },
      fixture.execution,
      fixture.attachments,
    ),
    /尚无已接收/,
  )
  const plugin = host([
    { ...event(), data: { ...event().data, source: { kind: 'plugin' } } },
  ])
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '销售台账.csv' },
      plugin.execution,
      plugin.attachments,
    ),
    /尚无已接收/,
  )
})

test('same-name different bytes are ambiguous, never latest; hash selects exactly one accepted reference', async () => {
  const events = [
    event(),
    event(Buffer.from('new queued data'), '销售台账.csv', 4),
  ]
  const fixture = host(events)
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '销售台账.csv' },
      fixture.execution,
      fixture.attachments,
    ),
    /同名附件/,
  )
  assert.equal(fixture.reads.length, 0)
  const selected = await readSalesAttachment(
    { attachmentName: '销售台账.csv', attachmentHash: hash(csv).slice(0, 8) },
    fixture.execution,
    fixture.attachments,
  )
  assert.equal(selected.sourceMessageId, 'message-2')
  const same = host([event(), event(csv, '销售台账.csv', 5)])
  assert.equal(
    (
      await readSalesAttachment(
        { attachmentName: '销售台账.csv' },
        same.execution,
        same.attachments,
      )
    ).sha256,
    hash(csv),
  )
})

test('captured references survive later uploads and names cannot become arbitrary paths', async () => {
  const events = [event()]
  const fixture = host(events)
  fixture.attachments.readFileStream = async function* (ref) {
    events.push(event(Buffer.from('later'), '销售台账.csv', 9))
    assert.equal(ref.attachmentId, `sha256:${hash(csv)}`)
    yield csv
  }
  assert.equal(
    (
      await readSalesAttachment(
        { attachmentName: '销售台账.csv' },
        fixture.execution,
        fixture.attachments,
      )
    ).sha256,
    hash(csv),
  )
  for (const name of [
    '../sales.csv',
    'C:\\secret.csv',
    '/tmp/file.xlsx',
    'key.txt',
    'file.csv\u0000',
  ])
    await assert.rejects(
      readSalesAttachment(
        { attachmentName: name },
        fixture.execution,
        fixture.attachments,
      ),
      /完整文件名/,
    )
  await assert.rejects(
    readSalesAttachment(
      { attachmentHash: hash(csv) },
      fixture.execution,
      fixture.attachments,
    ),
    /完整文件名/,
  )
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '销售台账.csv', attachmentHash: 'wrong' },
      fixture.execution,
      fixture.attachments,
    ),
    /至少 8 位/,
  )
})

test('Host refuses oversized, corrupt, overlong and cancelled streams', async () => {
  const tooLarge = event()
  tooLarge.data.content[0].attachment.bytes = 4 * 1024 * 1024 + 1
  const large = host([tooLarge])
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '销售台账.csv' },
      large.execution,
      large.attachments,
    ),
    /4 MiB/,
  )
  assert.equal(large.reads.length, 0)
  for (const bytes of [
    Buffer.alloc(csv.length),
    Buffer.concat([csv, Buffer.from('extra')]),
  ]) {
    const corrupt = host([event()], bytes)
    await assert.rejects(
      readSalesAttachment(
        { attachmentName: '销售台账.csv' },
        corrupt.execution,
        corrupt.attachments,
      ),
      /不一致/,
    )
  }
  const controller = new AbortController()
  const cancelled = host([event()], csv, controller)
  cancelled.attachments.readFileStream = async function* () {
    yield csv.subarray(0, 2)
    controller.abort()
    yield csv.subarray(2)
  }
  await assert.rejects(
    readSalesAttachment(
      { attachmentName: '销售台账.csv' },
      cancelled.execution,
      cancelled.attachments,
    ),
    { name: 'AbortError' },
  )
})

test('parent validates context shape, extension, size, exact encoding and digest', async () => {
  const context = await attachedContext()
  assert.deepEqual(
    decodeAgentAttachment(parseAgentToolContext(context).attachment).content,
    csv,
  )
  for (const change of [
    { name: '../evil.csv' },
    { name: 'script.js' },
    { size: 4 * 1024 * 1024 + 1 },
    { sha256: 'wrong' },
    { sourceSeq: -1 },
  ])
    assert.throws(
      () =>
        parseAgentToolContext({
          ...context,
          attachment: { ...context.attachment, ...change },
        }),
      (error) => error.status === 422,
    )
  for (const change of [
    { size: csv.length + 1 },
    { sha256: 'a'.repeat(64) },
    { contentBase64: Buffer.alloc(csv.length).toString('base64') },
  ]) {
    const parsed = parseAgentToolContext({
      ...context,
      attachment: { ...context.attachment, ...change },
    })
    assert.throws(
      () => decodeAgentAttachment(parsed.attachment),
      (error) => error.status === 422,
    )
  }
})

test('IPC ignores model-forged context and binds owner/session independently of args', async () => {
  const child = new EventEmitter()
  child.connected = true
  const messages = []
  child.send = (message, callback) => {
    messages.push(message)
    callback?.()
  }
  const calls = []
  const channel = new BusinessHostChannel(child, 'owner-real', {
    async execute(...args) {
      calls.push(args)
      return { ok: true }
    },
  })
  try {
    const context = await attachedContext()
    child.emit('message', {
      type: 'business-tool',
      id: 'bad',
      sessionId: context.sessionId,
      tool: 'spreadsheet_report',
      args: { context },
    })
    await new Promise(setImmediate)
    assert.equal(calls.length, 0)
    assert.match(messages[0].error, /缺少/)
    child.emit('message', {
      type: 'business-tool',
      id: 'wrong-session',
      sessionId: 'other-session',
      tool: 'spreadsheet_report',
      args: {},
      context,
    })
    await new Promise(setImmediate)
    assert.equal(calls.length, 0)
    assert.match(messages.at(-1).error, /会话不匹配/)
    child.emit('message', {
      type: 'business-tool',
      id: 'good',
      owner: 'attacker',
      sessionId: context.sessionId,
      tool: 'spreadsheet_report',
      args: { __context: { ...context, sessionId: 'other-session' } },
      context,
    })
    await new Promise(setImmediate)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'owner-real')
    assert.equal(calls[0][5].sessionId, 'session-one')
  } finally {
    channel.close()
  }
})

function serviceFixture() {
  const saved = []
  const sourceReads = []
  let allowed = true
  const binding = {
    presetId: 'business-one',
    resourceOwnerId: 'owner-real',
    definition: {
      id: 'agent-one',
      version: 1,
      name: '销售助手',
      toolIds: ['spreadsheet_report'],
      skillIds: [],
      knowledgeBaseIds: [],
      knowledgeAssetIds: ['bound-sales'],
    },
    assets: [{ id: 'bound-sales', name: '演示.csv', kind: 'knowledge' }],
  }
  const service = {
    async binding(owner, session) {
      if (owner !== 'owner-real' || session !== 'session-one')
        throw Object.assign(new Error('not found'), { status: 404 })
      return binding
    },
    async available() {
      return binding.definition
    },
    options: {
      getAccount: async () => ({
        permissions: allowed ? ['sessions.run', 'files.write'] : [],
      }),
      hub: {
        store: {
          async session(id, owner) {
            if (id !== 'session-one' || owner !== 'owner-real')
              throw Object.assign(new Error('not found'), { status: 404 })
            return {
              executor_kind: 'server-agent',
              connector_id: 'connector-one',
            }
          },
        },
        async connectorAllowed() {},
      },
      db: {
        async query(sql, params) {
          if (sql.startsWith('SELECT owner_user_id FROM business_agents'))
            return [{ owner_user_id: 'owner-real' }]
          if (sql.startsWith('SELECT id FROM business_agent_tools'))
            return [{ id: 'spreadsheet_report' }]
          if (sql.startsWith('SELECT name,content')) {
            sourceReads.push(params)
            return [
              {
                name: '演示.csv',
                content: Buffer.from(
                  csv.toString().replace('3,250,100', '1,2,1'),
                ),
              },
            ]
          }
          return []
        },
      },
      files: {
        async save(owner, session, name, bytes, mediaType, fileId) {
          saved.push({ owner, session, name, bytes })
          return { fileId, name, mediaType, size: bytes.length }
        },
      },
      async audit() {},
    },
  }
  return {
    service,
    saved,
    sourceReads,
    revoke: () => {
      allowed = false
    },
  }
}

test('Office executes actual chat attachment bytes, not bound demo sales, and retains plain bound mode', async () => {
  const fixture = serviceFixture()
  const context = await attachedContext()
  const result = await executeAgentTool(
    fixture.service,
    'owner-real',
    'session-one',
    'spreadsheet_report',
    { attachmentName: '销售台账.csv' },
    new AbortController().signal,
    context,
  )
  assert.equal(result.summary.revenue, 750)
  assert.equal(result.summary.profit, 450)
  assert.equal(fixture.sourceReads.length, 0)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(fixture.saved[0].bytes)
  assert.equal(
    workbook.getWorksheet('销售明细').getCell('H3').value.result,
    750,
  )
  const bound = await executeAgentTool(
    fixture.service,
    'owner-real',
    'session-one',
    'spreadsheet_report',
    { __callId: 'bound-call' },
    new AbortController().signal,
  )
  assert.equal(bound.summary.revenue, 2)
  assert.equal(fixture.sourceReads.length, 1)
})

test('missing or forged attachment never falls back; owner, scope and permission guards remain', async () => {
  const fixture = serviceFixture()
  const context = await attachedContext()
  const run = (args, metadata = context, owner = 'owner-real') =>
    executeAgentTool(
      fixture.service,
      owner,
      'session-one',
      'spreadsheet_report',
      args,
      new AbortController().signal,
      metadata,
    )
  await assert.rejects(
    run(
      { attachmentName: '销售台账.csv', __context: context },
      { ...context, attachment: undefined },
    ),
    (e) => e.status === 422,
  )
  await assert.rejects(
    run({ attachmentName: 'wrong.csv' }),
    (e) => e.status === 422,
  )
  await assert.rejects(
    run(
      { attachmentName: '销售台账.csv' },
      { ...context, presetId: 'business-other' },
    ),
    (e) => e.status === 403,
  )
  await assert.rejects(
    run({ attachmentName: '销售台账.csv' }, context, 'other-owner'),
    (e) => e.status === 404,
  )
  fixture.revoke()
  await assert.rejects(
    run({ attachmentName: '销售台账.csv' }),
    (e) => e.status === 403,
  )
  assert.equal(fixture.saved.length, 0)
  assert.equal(fixture.sourceReads.length, 0)
})
