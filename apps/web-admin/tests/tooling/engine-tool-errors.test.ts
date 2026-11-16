import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installTools } from '../../engine-adapter/src/tools.ts'
import type {
  Host,
  Json,
  ToolDefinition,
} from '../../engine-adapter/src/contracts.ts'

test('模型仅收到允许的参数字段提示，其他异常与错误状态仍隐藏', async () => {
  const registered: { definition?: ToolDefinition } = {}
  const installed = Promise.withResolvers<void>()
  let failure: Json = true
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
        ask: async () => {
          throw new Error('本测试不应发起执行确认')
        },
      },
    },
  }
  const adapter = installTools(
    Promise.resolve(host),
    async () => ({ defineTool: (value: ToolDefinition) => value }),
    (frame) => {
      if (frame.type === 'tool-installed') installed.resolve()
      if (frame.type === 'tool-call')
        queueMicrotask(() =>
          adapter.accept({
            type: 'tool-result',
            id: frame.id!,
            error: failure,
          }),
        )
    },
  )
  adapter.accept({
    type: 'tool-install',
    id: 'install',
    tool: {
      id: 'synthetic_tool',
      name: '合成工具',
      description: '错误契约测试',
      parameters: {},
      revision: 1,
    },
  })
  await installed.promise
  assert.ok(registered.definition)
  const cases: [Json, string][] = [
    [
      {
        status: 422,
        code: 'tool_arguments_invalid',
        detail: 'scenes.0.scriptRange 不符合 type 规则',
      },
      'scenes.0.scriptRange 不符合 type 规则',
    ],
    [
      {
        status: 422,
        code: 'studio_tool_arguments_invalid',
        detail: 'shots.0.duration 无效',
      },
      'shots.0.duration 无效',
    ],
    [
      { status: 422, code: 'tool_arguments_invalid', detail: 'x'.repeat(2000) },
      'x'.repeat(1000),
    ],
    [
      {
        status: 500,
        code: 'tool_arguments_invalid',
        detail: 'private-server-data',
      },
      '工具执行失败',
    ],
    [
      {
        status: 422,
        code: 'configuration_invalid',
        detail: 'private-config-data',
      },
      '工具执行失败',
    ],
    ['private-raw-error', '工具执行失败'],
    [true, '工具执行失败'],
  ]
  for (const [value, expected] of cases) {
    failure = value
    await assert.rejects(
      registered.definition.execute(
        {},
        {
          agent: { id: 'synthetic-agent', status: 'running' },
          callId: 'error-call',
          signal: new AbortController().signal,
        },
      ),
      { message: expected },
    )
  }
})
