'use client'

import * as React from 'react'
import { Server, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { loadStoredSession, subscribeSession } from '@/features/auth/session'
import {
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'
import {
  serverAgentApi,
  type ServerAgent,
} from '@/features/dashboard/server-agent'
import { useWorkbenchState } from '@/features/workbench/memory'
import {
  INITIAL_PREPARATION,
  prepareWorkbenchAgent,
} from '@/features/workbench/agent-lifecycle'

export function ServerAgentControl({
  onReady,
  onAvailable,
}: {
  onReady: (agent: ServerAgent) => void
  onAvailable?: () => void
}) {
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  if (!session) return null
  return (
    <ScopedServerAgentControl
      key={JSON.stringify([session?.userId, session?.authzVersion])}
      onReady={onReady}
      onAvailable={onAvailable}
    />
  )
}

function ScopedServerAgentControl({
  onReady,
  onAvailable,
}: {
  onReady: (agent: ServerAgent) => void
  onAvailable?: () => void
}) {
  const tr = useManagementText()
  const [preparation] = useWorkbenchState(
    'agent-preparation',
    INITIAL_PREPARATION,
  )
  const resource = useManagementResource('server-agent', serverAgentApi.get, {
    autoRefreshMs: 2000,
  })
  const announcedTarget = React.useRef<string | null>(null)
  const agent = resource.data?.agent
  const ready =
    agent?.status === 'running' &&
    !!agent.connectorId &&
    !!agent.runtimeId &&
    !!agent.projectId
  React.useEffect(() => {
    const target = ready
      ? JSON.stringify([agent?.connectorId, agent?.runtimeId, agent?.projectId])
      : null
    if (target && announcedTarget.current !== target) onAvailable?.()
    announcedTarget.current = target
  }, [agent, onAvailable, ready])
  const diagnostic = resource.error || agent?.error || preparation.error
  const unconfigured =
    agent?.status === 'stopped' &&
    agent.error === 'server Agent supervisor is not configured'
  const failed = !!diagnostic || agent?.status === 'error'
  const preparing = !failed && (!ready || resource.busy)
  const status = resource.error
    ? tr('状态获取失败', 'Status unavailable')
    : unconfigured
      ? tr('服务端未配置', 'Server not configured')
      : failed
        ? tr('暂不可用', 'Unavailable')
        : ready
          ? tr('已就绪', 'Ready')
          : tr('自动准备中', 'Preparing automatically')
  const retry = () => {
    if (resource.error && !agent?.error && agent?.status !== 'error') {
      resource.reload()
      return
    }
    void resource.perform(() => prepareWorkbenchAgent(true))
  }
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 text-sm">
      <div className="min-w-0">
        <span className="flex items-center gap-2 font-medium">
          <Server className="size-4" />
          {tr('服务端 Agent', 'Server Agent')}
        </span>
        <p className="mt-1 text-xs text-muted-foreground">
          {tr(
            '无需连接电脑，手机、网页和桌面共用会话。个人模型在设置中配置。',
            'No computer required. Continue the same session on mobile, web and desktop. Configure personal models in Settings.',
          )}
        </p>
        {diagnostic && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {unconfigured
              ? tr(
                  '请先配置服务端 Agent 运行环境，完成后重试。',
                  'Configure the Server Agent runtime, then retry.',
                )
              : diagnostic}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          {preparing && <Loader2 className="size-4 animate-spin" />}
          {status}
        </span>
        {ready && !resource.error ? (
          <Button size="sm" variant="outline" onClick={() => onReady(agent)}>
            {tr('使用服务端 Agent', 'Use Server Agent')}
          </Button>
        ) : failed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={resource.busy}
            onClick={retry}
          >
            {tr('重试', 'Retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
