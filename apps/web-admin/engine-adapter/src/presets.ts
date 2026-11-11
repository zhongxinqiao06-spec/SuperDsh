import { fields } from './contracts.ts'
import type { Fields, Host } from './contracts.ts'
import { composition, compositions } from './preset-plugin.ts'
import type { PresetAgent, PresetComposition } from './preset-plugin.ts'

/** 冻结预设仅加载随产品构建的固定适配插件，不接受外部模块路径。 */
export function installPresets(
  application: Promise<Host>,
  send: (frame: Fields) => void,
) {
  const installed = new Map<string, string>()
  const overlays = new WeakMap<PresetAgent, PresetComposition>()
  const live = new Map<string, Fields>()
  const attach = (host: Host, agent: PresetAgent, value: Fields) => {
    const registry = host.ctx.get('agentPresets')
    if (registry?.composedPreset(agent.ctx) === value.id) return
    const previous = overlays.get(agent)
    if (previous) previous.update(value)
    else {
      if (agent.status === 'running')
        throw new Error('Cannot replace a running agent preset')
      overlays.set(
        agent,
        composition(agent.ctx, value, (candidate) => candidate === agent),
      )
    }
  }
  void application.then(async (host) => {
    await host.ready
    host.ctx.on('agent/created', ({ agent }) => {
      const value = live.get(agent.id)
      if (value) attach(host, agent, value)
    })
  })
  return {
    accept(message: Fields): boolean {
      if (message.type !== 'preset-install' || typeof message.id !== 'string')
        return false
      const identifier = message.id
      void (async () => {
        const supplied = fields(message.preset)
        const { externalSessionId, ...value } = supplied
        if (
          typeof value.id !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(value.id) ||
          typeof value.name !== 'string' ||
          !Number.isSafeInteger(value.revision) ||
          Number(value.revision) < 1
        )
          throw new Error('Invalid preset identity')
        const signature = JSON.stringify(value)
        const host = await application
        await host.ready
        const registry = host.ctx.get('agentPresets')
        if (!registry) throw new Error('Preset registry unavailable')
        if (!installed.has(value.id)) {
          await registry.register({
            id: value.id,
            name: value.name,
            description: String(value.description ?? ''),
            plugins: [
              {
                name: new URL('./preset-plugin.mjs', import.meta.url).href,
                config: value,
              },
            ],
          })
          const entry = (await registry.list()).find(
            (item) => item.id === value.id,
          )
          if (!entry || entry.broken)
            throw new Error('Preset activation failed')
          installed.set(value.id, signature)
        }
        const controller = compositions.get(value.id)
        if (!controller) throw new Error('Preset activation incomplete')
        controller.update(value)
        if (typeof externalSessionId === 'string' && externalSessionId) {
          const agent = host.ctx.agents.get(externalSessionId)
          if (agent) attach(host, agent, value)
          live.set(externalSessionId, value)
        }
        installed.set(value.id, signature)
        send({ type: 'preset-installed', id: identifier })
      })().catch(() =>
        send({ type: 'preset-installed', id: identifier, error: true }),
      )
      return true
    },
  }
}
