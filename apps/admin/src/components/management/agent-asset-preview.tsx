'use client'

import * as React from 'react'
import {
  agentsApi,
  type AgentAsset,
  type AgentAssetPreview as PreviewFile,
} from '@/features/agents/api'
import {
  loadStoredSession,
  sessionIdentityRevision,
  subscribeSession,
} from '@/features/auth/session'
import { AgentPdfPreview } from './agent-pdf-preview'
import { ResourceState, useManagementText } from './controls'

export function supportsOfficePreview(name: string) {
  return /\.(pptx|docx)$/i.test(name)
}

export function AgentAssetPreview({ asset }: { asset: AgentAsset }) {
  const tr = useManagementText()
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  if (!supportsOfficePreview(asset.name))
    return (
      <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-sm">
        {asset.preview ||
          tr(
            '此文件暂不支持预览，可下载查看。',
            'Preview is unavailable for this file. Download it to view.',
          )}
      </div>
    )
  if (!session)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {tr('请登录后查看文档预览。', 'Sign in to preview this document.')}
      </p>
    )
  return (
    <OfficeAssetPreview
      key={`${sessionIdentityRevision()}:${session.authzVersion}:${asset.id}:${asset.sha256}`}
      asset={asset}
    />
  )
}

function OfficeAssetPreview({ asset }: { asset: AgentAsset }) {
  const tr = useManagementText()
  const [attempt, setAttempt] = React.useState(0)
  const [file, setFile] = React.useState<PreviewFile | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    const controller = new AbortController()
    const identity = sessionIdentityRevision()
    setFile(null)
    setError('')
    const load = async () => {
      try {
        // StrictMode replays mount effects synchronously; let its cleanup cancel
        // the discarded effect before it starts an expensive server conversion.
        await Promise.resolve()
        if (controller.signal.aborted || identity !== sessionIdentityRevision())
          return
        const result = await agentsApi.previewAsset(asset.id, controller.signal)
        if (controller.signal.aborted || identity !== sessionIdentityRevision())
          return
        if (result.mediaType !== 'application/pdf' || !result.contentBase64)
          throw new Error(tr('文档预览内容无效。', 'Invalid document preview.'))
        setFile(result)
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          identity === sessionIdentityRevision()
        )
          setError(
            cause instanceof Error
              ? cause.message
              : tr(
                  '无法生成文档预览，请重试。',
                  'Could not generate the preview. Please retry.',
                ),
          )
      }
    }
    void load()
    return () => controller.abort()
  }, [asset.id, attempt, tr])

  if (error)
    return (
      <ResourceState
        loading={false}
        error={error}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    )
  if (!file)
    return (
      <div
        role="status"
        className="flex min-h-64 items-center justify-center rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground"
      >
        {tr('正在生成文档预览…', 'Preparing document preview…')}
      </div>
    )
  return (
    <div className="min-w-0 space-y-2">
      {!!file.missingFonts?.length && (
        <p className="text-xs text-muted-foreground">
          {tr(
            '文档中的部分字体已使用替代字体显示。',
            'Some document fonts are displayed with substitute fonts.',
          )}
        </p>
      )}
      <AgentPdfPreview contentBase64={file.contentBase64} name={asset.name} />
    </div>
  )
}
