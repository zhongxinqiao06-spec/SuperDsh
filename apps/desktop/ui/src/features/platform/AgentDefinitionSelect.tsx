import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PlatformSelect } from './PlatformSelect.tsx'
import type { useAgentDefinitions } from './use-agent-definitions.ts'

export function AgentDefinitionSelect({
  agents,
  disabled,
}: {
  agents: ReturnType<typeof useAgentDefinitions>
  disabled: boolean
}) {
  if (!agents.visible) return null
  const selected = agents.items.find((agent) => agent.id === agents.selectedId)
  return (
    <div className="productAgentSelection">
      <div className="platformActions">
        <PlatformSelect
          label="产品智能体"
          value={agents.selectedId}
          side="top"
          disabled={disabled || agents.loading}
          onChange={agents.select}
          options={[
            {
              value: '',
              label: agents.loading ? '正在读取智能体…' : '通用服务端助手',
            },
            ...agents.items.map((agent) => ({
              value: agent.id,
              label: agent.name,
              detail: `v${agent.version} · ${agent.description}`,
            })),
          ]}
        />
        <Button
          size="sm"
          disabled={disabled || agents.loading}
          onClick={agents.refresh}
        >
          刷新智能体
        </Button>
      </div>
      {selected && (
        <small>{selected.description} · 会话创建后固定此智能体版本</small>
      )}
      {!agents.loading && !agents.error && !agents.items.length && (
        <small>暂无已发布智能体，可继续使用通用服务端助手。</small>
      )}
      {agents.error && (
        <p className="platformError" role="alert">
          智能体列表读取失败：{agents.error}。可重试或使用通用服务端助手。
        </p>
      )}
    </div>
  )
}
