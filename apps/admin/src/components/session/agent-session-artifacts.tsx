'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { agentsApi, saveAgentDownload } from '@/features/agents/api'
import { sessionIdentityRevision } from '@/features/auth/session'
import {
  ResourceState,
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'

export function AgentSessionArtifacts({
  sessionId,
  status,
}: {
  sessionId: string
  status: string
}) {
  const tr = useManagementText()
  const resource = useManagementResource(
    `agent-artifacts:${sessionId}:${status === 'idle' || status === 'error' ? 'settled' : 'active'}`,
    () => agentsApi.artifacts(sessionId),
  )
  const generation = React.useRef(sessionId)
  generation.current = sessionId
  const [downloading, setDownloading] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    generation.current = sessionId
    setError('')
    setDownloading(null)
    return () => {
      generation.current = ''
    }
  }, [sessionId])
  const download = async (fileId: string) => {
    if (downloading) return
    const identity = sessionIdentityRevision()
    setDownloading(fileId)
    setError('')
    try {
      const file = await agentsApi.downloadArtifact(sessionId, fileId)
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        saveAgentDownload(file)
    } catch (cause) {
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        setError(
          cause instanceof Error
            ? cause.message
            : tr('下载失败', 'Download failed'),
        )
    } finally {
      if (
        generation.current === sessionId &&
        identity === sessionIdentityRevision()
      )
        setDownloading(null)
    }
  }
  if (!resource.data?.agentDefinition && !resource.error) return null
  return (
    <section
      className="rounded-xl border bg-card p-4"
      aria-label={tr('智能体生成成果', 'Agent outputs')}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {tr('智能体生成成果', 'Agent outputs')}
          </h3>
          {resource.data?.agentDefinition && (
            <p className="mt-1 text-xs text-muted-foreground">
              {resource.data.agentDefinition.name} · v
              {resource.data.agentDefinition.version}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={resource.loading}
          onClick={resource.reload}
        >
          {tr('刷新', 'Refresh')}
        </Button>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error || error}
        onRetry={() => {
          setError('')
          resource.reload()
        }}
      />
      {resource.data?.items.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {tr(
            '尚未生成文件。可在对话中要求按模板生成 Excel 或 PPT。',
            'No files yet. Ask the agent to generate an Excel or PowerPoint file using its templates.',
          )}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {resource.data?.items.map((file) => (
          <li
            key={file.fileId}
            className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
          >
            <span className="min-w-0">
              <span className="block break-words font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {Math.max(1, Math.ceil(file.size / 1024))} KB
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!!downloading}
              onClick={() => void download(file.fileId)}
            >
              {downloading === file.fileId
                ? tr('下载中…', 'Downloading…')
                : tr('下载', 'Download')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
