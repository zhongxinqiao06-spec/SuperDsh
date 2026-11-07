'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  agentsApi,
  saveAgentDownload,
  type AgentArtifact,
} from '@/features/agents/api'
import { AgentArtifactPreview } from './agent-artifact-preview'
import { AgentSessionOfficeContext } from './agent-session-office-context'
import { SessionSkillRuns } from './skill-runs'
import {
  sessionIdentityRevision,
  subscribeSession,
} from '@/features/auth/session'
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
  const [preview, setPreview] = React.useState<AgentArtifact | null>(null)
  React.useEffect(() => subscribeSession(() => setPreview(null)), [])
  React.useEffect(() => {
    generation.current = sessionId
    setError('')
    setDownloading(null)
    setPreview(null)
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
      <SessionSkillRuns key={`skills:${sessionId}`} sessionId={sessionId} />
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
            '尚未生成文件。可在对话中提出需求，确认方案后在这里查看成果。',
            'No files yet. Describe your request in chat and confirm the plan to generate an artifact.',
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
              {file.quality && (
                <span
                  className={`block text-xs ${file.draft ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                >
                  {file.draft
                    ? tr(
                        '草稿 · 请查看质量诊断',
                        'Draft · Review quality diagnostics',
                      )
                    : tr(
                        '已完成结构与实际渲染检查',
                        'Structure and actual rendering checked',
                      )}
                  {file.quality.correctionRounds
                    ? ` · ${tr('排版修正', 'Layout corrections')} ${file.quality.correctionRounds}`
                    : ''}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {Math.max(1, Math.ceil(file.size / 1024))} KB
                {file.revision &&
                  ` · ${tr('方案', 'Plan')} v${file.revision.planVersion}${file.revision.previousArtifactId ? ` · ${tr('修订成果', 'Revision')}` : ''}`}
              </span>
              {file.diagnostics?.map((message, index) => (
                <span
                  key={index}
                  className="mt-1 block text-xs text-amber-600 dark:text-amber-400"
                >
                  {message}
                </span>
              ))}
            </span>
            <div className="flex shrink-0 gap-2">
              {/\.(xlsx|pptx|docx|png)$/i.test(file.name) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPreview(file)}
                >
                  {file.preview?.state === 'failed'
                    ? tr('重试预览', 'Retry preview')
                    : tr('预览', 'Preview')}
                </Button>
              )}
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
            </div>
          </li>
        ))}
      </ul>
      <AgentSessionOfficeContext
        key={sessionId}
        sessionId={sessionId}
        status={status}
      />
      {preview && (
        <AgentArtifactPreview
          key={`${sessionId}:${preview.fileId}`}
          sessionId={sessionId}
          file={preview}
          close={() => setPreview(null)}
        />
      )}
    </section>
  )
}
