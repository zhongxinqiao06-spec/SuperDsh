import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { AA_WORKSPACES } from './agents-anywhere-release-policy.mjs'

function loadRegions(workspace, names, expression, globals = {}) {
  const source = readFileSync(
    new URL(
      `../${workspace}/node_modules/@agents-anywhere/dsh-bridge-next/lib/index.js`,
      import.meta.url,
    ),
    'utf8',
  )
  const regions = names.map((name) => {
    const start = source.indexOf(`//#region src/host/dsh-runtime/${name}.ts`)
    const end = source.indexOf('//#endregion', start)
    assert.ok(start >= 0 && end > start, `Missing installed region ${name}`)
    return source.slice(start, end)
  })
  return runInNewContext(regions.join('\n') + ';' + expression, {
    createHash,
    randomUUID,
    Buffer,
    AbortController,
    AbortSignal,
    Request,
    delay,
    json: (value) => JSON.parse(JSON.stringify(value)),
    record: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {},
    ...globals,
  })
}

for (const workspace of AA_WORKSPACES) {
  test(`${workspace}: modern and legacy tool results settle their original calls`, () => {
    const createProjection = loadRegions(
      workspace,
      ['identity', 'tools', 'history'],
      'createProjection',
    )
    for (const legacy of [false, true]) {
      const projection = createProjection('native', 'platform')
      const apply = (type, data, seq) =>
        projection.apply({ type, data, seq, time: 1791528958000 + seq })
      apply('turn/start', { turn: 1 }, 0)
      apply(
        'tool/call',
        {
          callId: 'child-call',
          name: 'subagent',
          arguments: { target: 'child' },
        },
        1,
      )
      const content = [{ type: 'text', text: 'CHILD_COMPLETED' }]
      apply(
        'tool/result',
        {
          message: legacy
            ? {
                role: 'user',
                source: { kind: 'tool', callId: 'child-call' },
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'child-call',
                    content,
                    isError: false,
                  },
                ],
              }
            : {
                role: 'tool',
                toolCallId: 'child-call',
                source: { kind: 'tool', callId: 'child-call' },
                content,
                isError: false,
              },
          meta: { childId: 'child' },
        },
        2,
      )
      apply('turn/end', { reason: { kind: 'completed' } }, 3)
      const tools = projection.snapshot().filter((item) => item.type === 'tool')
      assert.equal(tools.length, 1)
      assert.equal(tools[0].status, 'done')
      assert.equal(tools[0].content.toolName, 'subagent')
      assert.equal(tools[0].content.output, 'CHILD_COMPLETED')
      assert.equal(tools[0].content.callId, 'child-call')
      assert.deepEqual(
        JSON.parse(JSON.stringify(tools[0].content.result)),
        content,
      )
      assert.equal(tools[0].content.dshResultMeta.childId, 'child')
    }
  })

  test(`${workspace}: native failed results and unfinished cancelled tools remain distinct`, () => {
    const createProjection = loadRegions(
      workspace,
      ['identity', 'tools', 'history'],
      'createProjection',
    )
    const projection = createProjection('native', 'platform')
    const events = [
      ['turn/start', { turn: 1 }],
      [
        'tool/call',
        { callId: 'failed', name: 'bash', arguments: { command: 'bad' } },
      ],
      [
        'tool/call',
        { callId: 'pending', name: 'bash', arguments: { command: 'wait' } },
      ],
      [
        'tool/result',
        {
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'failed' },
            content: [{ type: 'text', text: 'command failed' }],
            isError: true,
          },
        },
      ],
      ['turn/end', { reason: { kind: 'aborted' } }],
    ]
    events.forEach(([type, data], seq) =>
      projection.apply({ type, data, seq, time: 1791528958000 + seq }),
    )
    const tools = projection.snapshot().filter((item) => item.type === 'tool')
    assert.equal(tools.length, 2)
    assert.equal(
      tools.find((item) => item.content.callId === 'failed').status,
      'failed',
    )
    assert.equal(
      tools.find((item) => item.content.callId === 'pending').status,
      'interrupted',
    )
    assert.equal(
      tools.find((item) => item.content.callId === 'failed').content.output,
      'command failed',
    )
  })

  test(`${workspace}: official stream uses the five-argument carrier and closes its lifetime`, async () => {
    const InteractionStream = loadRegions(
      workspace,
      ['interaction-stream'],
      'InteractionStream',
    )
    let cleanup
    let observedSignal
    const replies = []
    const ready = {
      effect(start) {
        cleanup = start()
      },
      typertGateway: {
        wireStream: {
          async open(endpoint, payload, uplink, peer, signal) {
            assert.equal(endpoint, '$events')
            assert.equal(Object.keys(payload.args).length, 0)
            assert.equal(typeof uplink[Symbol.asyncIterator], 'function')
            assert.equal(peer, undefined)
            assert.ok(signal instanceof AbortSignal)
            observedSignal = signal
            return (async function* () {
              yield { type: 'ready', clientId: 'generation-1' }
              await delay(10000, undefined, { signal })
            })()
          },
        },
      },
      connection: {
        createSharedFetchHandler(path) {
          assert.equal(path, '/api')
          return {
            async fetch(request) {
              const body = await request.json()
              replies.push(body)
              return new Response(
                JSON.stringify({
                  type: 'server-response',
                  rpcId: body.rpcId,
                  result: { ok: true },
                }),
              )
            },
          }
        },
      },
    }
    const stream = new InteractionStream(
      {
        inject(services, start) {
          assert.ok(services.includes('approval'))
          start(ready)
          return { dispose: async () => cleanup() }
        },
      },
      async () => {},
      () => {},
      'approval',
    )
    try {
      for (let i = 0; i < 100 && !stream.available; i++) await delay(1)
      assert.equal(stream.available, true)
      await stream.reply('approval-1', {
        kind: 'result',
        value: 'allowed-once',
      })
      assert.equal(replies[0].payload.args.clientId, 'generation-1')
      assert.equal(replies[0].payload.args.eventId, 'approval-1')
    } finally {
      await stream.close()
    }
    assert.equal(observedSignal.aborted, true)
    assert.equal(stream.available, false)
    await assert.rejects(stream.reply('late', { kind: 'next' }))
  })

  test(`${workspace}: approvals reject duplicate, cancelled and expired decisions`, async () => {
    let receive
    const replies = []
    const UserApprovals = loadRegions(
      workspace,
      ['identity', 'approvals'],
      'UserApprovals',
      {
        InteractionStream: class {
          available = true
          constructor(_ctx, callback) {
            receive = callback
          }
          async reply(eventId, outcome) {
            replies.push({ eventId, outcome })
          }
          async close() {}
        },
      },
    )
    const approvals = new UserApprovals(
      {},
      async (id) => id === 'owned',
      () => {},
    )
    const ask = (eventId) =>
      receive({
        type: 'waterfall',
        event: 'approval/request',
        eventId,
        agentId: 'owned',
        request: { toolName: 'bash', callId: eventId },
      })
    const answer = (eventId) => {
      const notice = approvals
        .notices('connector', 'owned')
        .find((value) => value.metadata.eventId === eventId)
      return approvals.respond(
        'connector',
        'owned',
        notice.noticeId,
        'allow-once',
      )
    }
    await ask('first')
    await ask('first')
    assert.equal(approvals.notices('connector', 'owned').length, 1)
    const decisions = await Promise.all([answer('first'), answer('first')])
    assert.equal(decisions.filter((value) => value.ok).length, 1)
    assert.equal(replies.length, 1)
    assert.equal((await answer('first')).ok, false)
    await ask('cancelled')
    await receive({ type: 'cancel', eventId: 'cancelled' })
    assert.equal((await answer('cancelled')).ok, false)
    await ask('expired')
    approvals.observe('owned', { type: 'turn/end' })
    assert.equal((await answer('expired')).ok, false)
    assert.equal(replies.length, 1)
    await approvals.close()
  })
}
