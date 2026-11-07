'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AgentPdfPreview } from '@/components/management/agent-pdf-preview'
import {
  ResourceState,
  useManagementText,
} from '@/components/management/controls'
import {
  agentsApi,
  type AgentArtifact,
  type AgentArtifactPreview as PreviewData,
} from '@/features/agents/api'
import { sessionIdentityRevision } from '@/features/auth/session'

export function AgentArtifactPreview({
  sessionId,
  file,
  close,
}: {
  sessionId: string
  file: AgentArtifact
  close(): void
}) {
  const tr = useManagementText()
  const [attempt, setAttempt] = React.useState(0)
  const [preview, setPreview] = React.useState<PreviewData | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    const controller = new AbortController()
    const identity = sessionIdentityRevision()
    const timeout = setTimeout(() => {
      controller.abort()
      if (identity === sessionIdentityRevision())
        setError(
          tr(
            '预览超时，请重试或下载原文件。',
            'Preview timed out. Retry or download the original.',
          ),
        )
    }, 75_000)
    setPreview(null)
    setError('')
    void (async () => {
      await Promise.resolve()
      if (controller.signal.aborted) return
      try {
        const result = await agentsApi.previewArtifact(
          sessionId,
          file.fileId,
          controller.signal,
        )
        if (
          !controller.signal.aborted &&
          identity === sessionIdentityRevision()
        ) {
          if (
            !['application/pdf', 'image/png', 'image/jpeg'].includes(
              result.mediaType,
            ) ||
            !result.contentBase64
          )
            throw new Error('Invalid artifact preview')
          setPreview(result)
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          identity === sessionIdentityRevision()
        )
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        clearTimeout(timeout)
      }
    })()
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [sessionId, file.fileId, attempt, tr])
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90dvh] w-[min(96vw,72rem)] max-w-none flex-col overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{file.name}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <ResourceState
            loading={!preview && !error}
            error={error}
            onRetry={() => setAttempt((value) => value + 1)}
          />
          {preview && (
            <>
              {!!preview.missingFonts?.length && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {tr(
                    '部分字体使用替代字体显示。',
                    'Some fonts were substituted.',
                  )}
                </p>
              )}
              {preview.mediaType.startsWith('image/') ? (
                // Authenticated artifact bytes; no external URL or executable SVG.
                <img
                  className="h-auto w-full rounded-lg"
                  src={`data:${preview.mediaType};base64,${preview.contentBase64}`}
                  alt={file.name}
                />
              ) : (
                <AgentPdfPreview
                  contentBase64={preview.contentBase64}
                  name={file.name}
                />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
