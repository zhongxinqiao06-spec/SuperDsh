import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installTools } from '../../engine-adapter/src/tools.ts'
import type {
  Fields,
  Host,
  ToolDefinition,
} from '../../engine-adapter/src/contracts.ts'

test('等待确认时中断向 Python 撤销原方案，不调用确认执行', async () => {
  const registered: { definition?: ToolDefinition } = {}
  const frames: Fields[] = []
  const waiting = Promise.withResolvers<void>()
  const installed = Promise.withResolvers<void>()
  const host: Host = {
    ready: Promise.resolve(),
    shutdown: async () => {},
    ctx: {
      agents: { get: () => undefined },
      on: () => () => {},
      get: () => undefined,
      tools: {
        register: (definition) => {
          registered.definition = definition
          return () => {}
        },
      },
      userQuestions: {
        ask: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
            waiting.resolve()
          }),
      },
    },
  }
  const adapter = installTools(
    Promise.resolve(host),
    async () => ({ defineTool: (value: ToolDefinition) => value }),
    (frame) => {
      frames.push(frame)
      if (frame.type === 'tool-installed') installed.resolve()
      if (frame.type === 'tool-call')
        queueMicrotask(() =>
          adapter.accept({
            type: 'tool-result',
            id: frame.id!,
            result:
              frames.filter((item) => item.type === 'tool-call').length === 1
                ? {
                    confirmation: {
                      receiptId: 'synthetic-receipt',
                      proof: 'synthetic-proof',
                    },
                    plan: { title: '合成方案' },
                  }
                : { status: 'cancelled' },
          }),
        )
    },
  )
  adapter.accept({
    type: 'tool-install',
    id: 'install',
    tool: {
      id: 'synthetic_tool',
      name: '测试工具',
      description: '仅测试控制传输',
      parameters: {},
      revision: 1,
    },
  })
  await installed.promise
  assert.ok(registered.definition)
  const abort = new AbortController()
  const running = registered.definition.execute(
    {},
    {
      agent: { id: 'synthetic-agent', status: 'running' },
      callId: 'synthetic-call',
      signal: abort.signal,
    },
  )
  const stopped = assert.rejects(running, { name: 'AbortError' })
  await waiting.promise
  abort.abort()
  await stopped
  const calls = frames.filter((frame) => frame.type === 'tool-call')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.context, {
    phase: 'reject-confirmation',
    confirmation: { receiptId: 'synthetic-receipt', proof: 'synthetic-proof' },
    cancelledByUser: true,
  })
  assert.equal(calls[0]!.callId, calls[1]!.callId)
  assert.ok(!frames.some((frame) => frame.type === 'tool-cancel'))
})
