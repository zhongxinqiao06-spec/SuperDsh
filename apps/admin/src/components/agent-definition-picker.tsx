'use client'

import { Button } from '@/components/ui/button'
import {
  ResourceState,
  useManagementText,
} from '@/components/management/controls'
import type { AgentDefinition } from '@/features/agents/api'

export function AgentDefinitionPicker({
  value,
  onChange,
  items,
  loading,
  error,
  onRetry,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  items: AgentDefinition[]
  loading: boolean
  error: string
  onRetry: () => void
  disabled: boolean
}) {
  const tr = useManagementText()
  const selected = items.find((item) => item.id === value)
  const missing = !!value && !loading && !error && !selected
  return (
    <div className="mb-4 rounded-xl border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0 font-medium">
            {tr('业务智能体', 'Business agent')}
          </span>
          <select
            aria-label={tr('业务智能体', 'Business agent')}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-foreground"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled || loading || !!error}
          >
            <option value="">{tr('通用对话', 'General chat')}</option>
            {missing && (
              <option value={value}>
                {tr('原智能体已不可用', 'Previous agent is unavailable')}
              </option>
            )}
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || loading}
          onClick={onRetry}
        >
          {tr('刷新', 'Refresh')}
        </Button>
      </div>
      {selected && (
        <p className="mt-2 text-xs text-muted-foreground">
          {selected.description} · v{selected.version}
        </p>
      )}
      {!selected && !value && (
        <p className="mt-2 text-xs text-muted-foreground">
          {tr(
            '也可选择已发布的智能体，使用配置好的知识、模板、技能和工具。',
            'Choose a published agent to use its knowledge, templates, skills and tools.',
          )}
        </p>
      )}
      <ResourceState loading={loading} error={error} onRetry={onRetry} />
      {missing && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {tr(
            '此智能体已删除或取消发布，请重新选择后发送。',
            'This agent has been removed or unpublished. Choose another before sending.',
          )}
        </p>
      )}
    </div>
  )
}
