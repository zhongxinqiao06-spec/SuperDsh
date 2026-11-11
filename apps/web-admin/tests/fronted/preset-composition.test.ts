import { describe, expect, it } from 'vitest'
import { composition } from '../../engine-adapter/src/preset-plugin'
import type {
  PresetAgent,
  PresetContext,
} from '../../engine-adapter/src/preset-plugin'
import type { Fields } from '../../engine-adapter/src/contracts'

/** 适配插件作用域测试使用内存上下文；真实 Host 的切换另由集成验收覆盖。 */
function context() {
  type Guard = (execution: {
    name: string
    agent?: PresetAgent
  }) => string | undefined
  const guards = new Set<Guard>()
  const prompts = new Set<string>()
  const restrictions = new Set<string[]>()
  const ctx: PresetContext = {
    agents: { list: () => (agent ? [agent] : []) },
    agentPresets: { composedPreset: () => 'synthetic-preset' },
    tools: {
      presentAs: () => () => undefined,
      restrict: ({ allow }) => {
        restrictions.add(allow)
        return () => {
          restrictions.delete(allow)
        }
      },
      guard: (guard) => {
        guards.add(guard)
        return () => {
          guards.delete(guard)
        }
      },
    },
    systemPrompt: {
      section: ({ text }) => {
        prompts.add(text)
        return () => {
          prompts.delete(text)
        }
      },
    },
    on: () => () => undefined,
  }
  const agent: PresetAgent = { id: 'synthetic-agent', status: 'idle', ctx }
  return {
    ctx,
    agent,
    prompts,
    restrictions,
    allowed: (name: string) =>
      [...guards].every((guard) => !guard({ name, agent })),
  }
}

const initial: Fields = {
  id: 'synthetic-preset',
  revision: 1,
  prompt: 'first',
  toolIds: ['old-tool'],
}

describe('既有会话智能体预设切换', () => {
  it('空闲切换释放旧工具和提示，只授权新版本', () => {
    const state = context()
    const controller = composition(
      state.ctx,
      initial,
      (agent) => agent === state.agent,
    )
    expect(state.allowed('old-tool')).toBe(true)
    controller.update({
      ...initial,
      revision: 2,
      prompt: 'second',
      toolIds: ['new-tool'],
    })
    expect(state.allowed('old-tool')).toBe(false)
    expect(state.allowed('new-tool')).toBe(true)
    expect([...state.prompts]).toEqual(['second'])
    expect([...state.restrictions]).toEqual([['new-tool']])
    controller.dispose()
    expect(state.prompts.size).toBe(0)
    expect(state.restrictions.size).toBe(0)
  })

  it('运行中或同版本改写拒绝且不改变原作用域', () => {
    const state = context()
    const controller = composition(
      state.ctx,
      initial,
      (agent) => agent === state.agent,
    )
    state.agent.status = 'running'
    expect(() => controller.update({ ...initial, revision: 2 })).toThrow(
      'running',
    )
    state.agent.status = 'idle'
    expect(() => controller.update({ ...initial, toolIds: ['other'] })).toThrow(
      'revision',
    )
    expect(state.allowed('old-tool')).toBe(true)
    expect(state.allowed('other')).toBe(false)
  })

  it('新版本挂载失败后拒绝所有工具，修正重试才能恢复', () => {
    const state = context()
    const controller = composition(
      state.ctx,
      initial,
      (agent) => agent === state.agent,
    )
    expect(() =>
      controller.update({ ...initial, revision: 2, toolIds: null }),
    ).toThrow('Invalid')
    expect(state.allowed('old-tool')).toBe(false)
    expect(state.allowed('arbitrary-host-tool')).toBe(false)
    controller.update({ ...initial, revision: 2, toolIds: ['recovered'] })
    expect(state.allowed('recovered')).toBe(true)
    expect(state.allowed('old-tool')).toBe(false)
  })
})
