'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  agentsApi,
  saveAgentDownload,
  type AgentAsset,
  type AgentAssetKind,
} from '@/features/agents/api'
import { sessionIdentityRevision } from '@/features/auth/session'
import { AgentAssetPreview, supportsOfficePreview } from './agent-asset-preview'
import {
  dateLabel,
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementText,
} from './controls'
import {
  ManagementDialog,
  ManagementPagination,
  useClientPagination,
} from './presentation'

export function AgentAssetsPanel({
  assets,
  onUploaded,
  onRemove,
  disabled = false,
}: {
  assets: AgentAsset[]
  onUploaded: (asset: AgentAsset) => void | Promise<void>
  onRemove?: (asset: AgentAsset) => Promise<void>
  disabled?: boolean
}) {
  const tr = useManagementText()
  const [uploading, setUploading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [retryDownload, setRetryDownload] = React.useState<AgentAsset | null>(
    null,
  )
  const [name, setName] = React.useState('')
  const [kind, setKind] = React.useState<AgentAssetKind>('knowledge')
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<AgentAsset | null>(null)
  const [query, setQuery] = React.useState('')
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const filtered = React.useMemo(
    () =>
      assets.filter((asset) =>
        asset.name
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    [assets, query],
  )
  const pagination = useClientPagination(filtered, query)
  const kindLabel = (value: AgentAssetKind) =>
    ({
      knowledge: tr('知识资料', 'Knowledge'),
      'spreadsheet-template': tr('Excel 模板', 'Spreadsheet template'),
      'presentation-template': tr('PPT 模板', 'Presentation template'),
    })[value]
  const accept =
    kind === 'knowledge'
      ? '.txt,.md,.csv,.xlsx,.docx'
      : kind === 'spreadsheet-template'
        ? '.xlsx'
        : '.pptx'
  const upload = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || busy || disabled) return
    const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase()
    if (!extension || !accept.split(',').includes(extension)) {
      setError(
        tr(
          '所选文件类型与资料类型不一致。',
          'The selected file does not match this resource type.',
        ),
      )
      return
    }
    if (!name.trim().toLowerCase().endsWith(extension)) {
      setError(
        tr(
          `名称请保留原文件扩展名 ${extension}。`,
          `Keep the original ${extension} file extension in the name.`,
        ),
      )
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(
        tr('文件不能超过 4 MB。', 'The file must be no larger than 4 MB.'),
      )
      return
    }
    const identity = sessionIdentityRevision()
    setBusy(true)
    setError('')
    try {
      const contentBase64 = await fileBase64(file)
      if (!mounted.current || identity !== sessionIdentityRevision()) return
      const { asset } = await agentsApi.upload({
        name: name.trim(),
        kind,
        contentBase64,
      })
      if (!mounted.current || identity !== sessionIdentityRevision()) return
      await onUploaded(asset)
      if (!mounted.current || identity !== sessionIdentityRevision()) return
      setUploading(false)
      setFile(null)
    } catch (cause) {
      if (mounted.current && identity === sessionIdentityRevision())
        setError(
          cause instanceof Error
            ? cause.message
            : tr('上传失败', 'Upload failed'),
        )
    } finally {
      if (mounted.current && identity === sessionIdentityRevision())
        setBusy(false)
    }
  }
  const download = async (asset: AgentAsset) => {
    if (busy || disabled) return
    const identity = sessionIdentityRevision()
    setBusy(true)
    setError('')
    setRetryDownload(asset)
    try {
      const file = await agentsApi.downloadAsset(asset.id)
      if (!mounted.current || identity !== sessionIdentityRevision()) return
      saveAgentDownload(file)
    } catch (cause) {
      if (mounted.current && identity === sessionIdentityRevision())
        setError(
          cause instanceof Error
            ? cause.message
            : tr('下载失败', 'Download failed'),
        )
    } finally {
      if (mounted.current && identity === sessionIdentityRevision())
        setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="max-w-sm"
          aria-label={tr('搜索资料和模板', 'Search resources and templates')}
          placeholder={tr('搜索资料和模板', 'Search resources and templates')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          disabled={busy || disabled}
          onClick={() => {
            setName('')
            setKind('knowledge')
            setFile(null)
            setError('')
            setUploading(true)
          }}
        >
          {tr('上传资料或模板', 'Upload resource or template')}
        </Button>
      </div>
      {!uploading && (
        <ResourceState
          loading={false}
          error={error}
          onRetry={() => {
            if (retryDownload) void download(retryDownload)
          }}
        />
      )}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('名称', 'Name')}</th>
              <th>{tr('类型', 'Type')}</th>
              <th>{tr('大小', 'Size')}</th>
              <th>{tr('上传时间', 'Uploaded')}</th>
              <th>{tr('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((asset) => (
              <tr key={asset.id}>
                <td className="font-medium">{asset.name}</td>
                <td>{kindLabel(asset.kind)}</td>
                <td>{Math.max(1, Math.ceil(asset.size / 1024))} KB</td>
                <td>{dateLabel(asset.createdAt)}</td>
                <td>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setError('')
                        setPreview(asset)
                      }}
                    >
                      {tr('查看', 'View')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || disabled}
                      onClick={() => void download(asset)}
                    >
                      {tr('下载', 'Download')}
                    </Button>
                    {onRemove && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || disabled}
                        onClick={async () => {
                          setBusy(true)
                          setError('')
                          const identity = sessionIdentityRevision()
                          try {
                            await onRemove(asset)
                          } catch (cause) {
                            if (
                              mounted.current &&
                              identity === sessionIdentityRevision()
                            )
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              )
                          } finally {
                            if (
                              mounted.current &&
                              identity === sessionIdentityRevision()
                            )
                              setBusy(false)
                          }
                        }}
                      >
                        {tr('移出知识库', 'Unlink')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!pagination.total && (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  {tr(
                    '暂无资料或模板。上传后可在智能体配置中选择。',
                    'No resources or templates. Upload files to make them available in agent configuration.',
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ManagementPagination
        {...pagination}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
      />
      <ManagementDialog
        open={uploading}
        onOpenChange={setUploading}
        title={tr('上传资料或模板', 'Upload resource or template')}
        busy={busy}
        error={error}
        description={tr(
          '知识资料支持 TXT、Markdown、CSV、XLSX 和 DOCX；输出模板支持 XLSX 或 PPTX。文件最大 4 MB。',
          'Knowledge supports TXT, Markdown, CSV, XLSX and DOCX; output templates support XLSX or PPTX. Maximum file size: 4 MB.',
        )}
      >
        <form onSubmit={upload} className="space-y-4">
          <fieldset disabled={busy || disabled} className="space-y-4">
            <FieldLabel title={tr('类型', 'Type')}>
              <select
                className="h-9 rounded-md border bg-background px-3"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as AgentAssetKind)
                  setFile(null)
                }}
              >
                {(
                  [
                    'knowledge',
                    'spreadsheet-template',
                    'presentation-template',
                  ] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {kindLabel(value)}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel title={tr('文件', 'File')}>
              <Input
                key={kind}
                required
                type="file"
                accept={accept}
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null
                  setFile(next)
                  if (next) setName(next.name)
                }}
              />
            </FieldLabel>
            <FieldLabel
              title={tr(
                '名称（保留文件扩展名）',
                'Name (keep the file extension)',
              )}
            >
              <Input
                required
                maxLength={150}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FieldLabel>
            {kind !== 'knowledge' && (
              <p className="text-xs text-muted-foreground">
                {tr(
                  '模板需保留可填充的占位符。建议先下载演示模板，再修改版式和示例内容。',
                  'Templates need fillable placeholders. Download a demo template first, then adapt its layout and sample content.',
                )}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setUploading(false)}
              >
                {tr('取消', 'Cancel')}
              </Button>
              <Button type="submit" disabled={!file}>
                {busy ? tr('上传中…', 'Uploading…') : tr('上传', 'Upload')}
              </Button>
            </div>
          </fieldset>
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={!!preview}
        onOpenChange={(open) => !open && setPreview(null)}
        title={preview?.name ?? tr('资料预览', 'Preview')}
        className={
          preview && supportsOfficePreview(preview.name)
            ? 'sm:max-w-5xl'
            : undefined
        }
        error={error}
        description={
          preview
            ? `${kindLabel(preview.kind)} · ${dateLabel(preview.createdAt)}`
            : undefined
        }
        footer={
          <Button
            variant="outline"
            disabled={busy || disabled || !preview}
            onClick={() => preview && void download(preview)}
          >
            {busy
              ? tr('下载中…', 'Downloading…')
              : tr('下载原文件', 'Download original')}
          </Button>
        }
      >
        {preview && <AgentAssetPreview asset={preview} />}
      </ManagementDialog>
    </div>
  )
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () =>
      reject(new Error('无法读取文件 / Could not read file'))
    reader.readAsDataURL(file)
  })
}
