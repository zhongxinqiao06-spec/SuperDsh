'use client'

import * as React from 'react'
import { agentsApi } from '@/features/agents/api'
import {
  ResourceState,
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'
import { sessionIdentityRevision } from '@/features/auth/session'

export function SessionAgentBinding({
  sessionId,
  status,
  takeover,
}: {
  sessionId: string
  status: string
  takeover: boolean
}) {
  const tr = useManagementText()
  const resource = useManagementResource(
    `session-agent:${sessionId}:${status}`,
    async () => {
      const [catalog, binding] = await Promise.all([
        agentsApi.available(),
        agentsApi.binding(sessionId),
      ])
      return { ...binding, items: catalog.items }
    },
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const generation = React.useRef(sessionId)
  generation.current = sessionId
  React.useEffect(() => {
    setError('')
    setBusy(false)
    return () => {
      generation.current = ''
    }
  }, [sessionId])
  const change = async (id: string) => {
    if (!id || !resource.data || busy) return
    const identity = sessionIdentityRevision()
    setBusy(true)
    setError('')
    try {
      await agentsApi.bind(sessionId, id, resource.data.bindingVersion)
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        resource.reload()
    } catch (cause) {
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-xl border bg-card p-3 text-sm">
      <label className="flex items-center gap-3">
        <span>{tr('本会话智能体', 'Session agent')}</span>
        <select
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3"
          aria-label={tr('本会话智能体', 'Session agent')}
          value={resource.data?.agentDefinition?.id ?? ''}
          disabled={
            busy ||
            resource.loading ||
            !takeover ||
            !['idle', 'error'].includes(status)
          }
          onChange={(event) => void change(event.target.value)}
        >
          <option value="" disabled>
            {tr('选择已发布智能体', 'Choose a published agent')}
          </option>
          {resource.data?.agentDefinition &&
            !resource.data.items.some(
              (item) => item.id === resource.data!.agentDefinition!.id,
            ) && (
              <option value={resource.data.agentDefinition.id}>
                {resource.data.agentDefinition.name} ·{' '}
                {tr('已停用', 'Unavailable')}
              </option>
            )}
          {resource.data?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · v{item.version}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {tr(
          '切换只影响后续任务，旧方案与成果保留原配置。运行中请先等待或取消任务。',
          'Switches apply to future tasks. Existing plans and artifacts retain their configuration. Wait for or cancel a running task first.',
        )}
      </p>
      <ResourceState
        loading={resource.loading || busy}
        error={error || resource.error}
        onRetry={resource.reload}
      />
    </div>
  )
}
