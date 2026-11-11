import type { Fields } from './contracts.ts'

interface Assembly {
  tools: { name: string }[]
  [key: string]: unknown
}

export interface PresetAgent {
  id: string
  status: string
  ctx: PresetContext
}

export interface PresetContext {
  agents: { list(): PresetAgent[] }
  agentPresets: { composedPreset(ctx: PresetContext): string | undefined }
  tools: {
    presentAs(value: string): () => void
    restrict(value: { allow: string[] }): () => void
    guard(
      callback: (execution: {
        name: string
        agent?: PresetAgent
      }) => string | undefined,
    ): () => void
  }
  systemPrompt: {
    section(value: {
      name: string
      order: number
      text: string
      complete: boolean
      interpolate: boolean
    }): () => void
  }
  on(
    event: 'system-prompt/assemble',
    callback: (
      assembly: Assembly,
      context: unknown,
      next: () => Promise<Assembly>,
    ) => Promise<Assembly>,
  ): () => void
  on(
    event: 'agent/created',
    callback: (value: { agent: PresetAgent }) => void,
  ): () => void
  on(event: 'dispose', callback: () => void): () => void
}

export interface PresetComposition {
  update(value: Fields): void
  dispose(): void
}

export const inject = ['tools', 'systemPrompt', 'agentPresets', 'agents']
export const compositions = new Map<string, PresetComposition>()

/** 只挂载通用提示和授权工具，资源选择与阶段执行仍由 Python 业务服务决定。 */
function mount(
  ctx: PresetContext,
  configuration: Fields,
  accepts: (agent: PresetAgent) => boolean,
): () => void {
  if (
    typeof configuration.prompt !== 'string' ||
    !Array.isArray(configuration.toolIds) ||
    !configuration.toolIds.every((item) => typeof item === 'string')
  )
    throw new Error('Invalid frozen preset')
  const allowed = new Set(configuration.toolIds)
  const disposers: (() => void)[] = []
  const release = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
  try {
    disposers.push(ctx.tools.presentAs('native'))
    disposers.push(
      ctx.tools.guard((execution) =>
        execution.agent &&
        accepts(execution.agent) &&
        allowed.has(execution.name)
          ? undefined
          : '当前会话未授权此工具',
      ),
    )
    disposers.push(
      ctx.systemPrompt.section({
        name: 'superdsh-frozen-agent',
        order: 1,
        text: configuration.prompt,
        complete: true,
        interpolate: false,
      }),
    )
    disposers.push(
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const value = await next()
        return {
          ...value,
          tools: value.tools.filter((tool) => allowed.has(tool.name)),
        }
      }),
    )
    const attached = new WeakSet<PresetAgent>()
    const restrict = (agent: PresetAgent) => {
      if (!accepts(agent) || attached.has(agent)) return
      attached.add(agent)
      disposers.push(agent.ctx.tools.restrict({ allow: [...allowed] }))
    }
    disposers.push(ctx.on('agent/created', ({ agent }) => restrict(agent)))
    for (const agent of ctx.agents.list()) restrict(agent)
    return release
  } catch (error) {
    release()
    throw error
  }
}

/** 空闲时切换版本；安装失败保持拒绝，绝不能退回 Host 全量工具。 */
export function composition(
  ctx: PresetContext,
  initial: Fields,
  accepts: (agent: PresetAgent) => boolean,
): PresetComposition {
  let current = initial
  let release = mount(ctx, current, accepts)
  return {
    update(next) {
      if (JSON.stringify(next) === JSON.stringify(current)) return
      if (Number(next.revision) <= Number(current.revision))
        throw new Error('Preset revision conflict')
      if (
        ctx.agents
          .list()
          .some((agent) => accepts(agent) && agent.status === 'running')
      )
        throw new Error('Cannot replace a running agent preset')
      release()
      const deny = ctx.tools.guard(() => '智能体配置正在更新，请重试')
      try {
        release = mount(ctx, next, accepts)
        current = next
        deny()
      } catch (error) {
        release = deny
        throw error
      }
    },
    dispose() {
      release()
    },
  }
}

export function apply(ctx: PresetContext, configuration: Fields): void {
  const id = String(configuration.id)
  const controller = composition(
    ctx,
    configuration,
    (agent) => ctx.agentPresets.composedPreset(agent.ctx) === id,
  )
  compositions.set(id, controller)
  ctx.on('dispose', () => {
    if (compositions.get(id) === controller) compositions.delete(id)
    controller.dispose()
  })
}
