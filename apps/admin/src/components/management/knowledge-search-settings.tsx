'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  knowledgeApi,
  type EmbeddingProfile,
} from '@/features/agents/knowledge-api'
import {
  FieldLabel,
  ResourceState,
  useManagementResource,
  useManagementText,
} from './controls'
import { ManagementDialog } from './presentation'

export function KnowledgeSearchSettings({
  onClose,
  onUpdated,
}: {
  onClose: () => void
  onUpdated: () => void
}) {
  const tr = useManagementText()
  const resource = useManagementResource(
    'embedding-settings',
    knowledgeApi.settings,
  )
  const [kind, setKind] = React.useState<EmbeddingProfile['kind']>('local')
  const [model, setModel] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [dimensions, setDimensions] = React.useState(512)
  const [revision, setRevision] = React.useState('v1')
  const [apiKey, setApiKey] = React.useState('')
  const [message, setMessage] = React.useState('')
  React.useEffect(() => {
    if (!resource.data) return
    const profile = resource.data.profile
    setKind(profile.kind)
    setModel(profile.kind === 'local' ? '' : profile.model)
    setBaseUrl(profile.baseUrl ?? '')
    setDimensions(profile.dimensions)
    setRevision(profile.kind === 'local' ? 'v1' : profile.revision)
    setApiKey('')
  }, [resource.data])
  const save = async () => {
    if (!resource.data) return
    const ok = await resource.perform(() =>
      knowledgeApi.saveSettings({
        version: resource.data!.version,
        kind,
        ...(kind === 'openai-compatible'
          ? {
              model: model.trim(),
              dimensions,
              revision: revision.trim(),
              baseUrl: baseUrl.trim(),
              ...(apiKey ? { apiKey } : {}),
            }
          : {}),
      }),
    )
    setApiKey('')
    if (ok) {
      onUpdated()
      onClose()
    }
  }
  const prepare = async () => {
    setMessage('')
    if (await resource.perform(knowledgeApi.prepareLocal)) {
      setMessage(
        tr(
          '固定版本模型已下载并通过校验，可以保存使用。',
          'The pinned model is downloaded and verified. You can now save.',
        ),
      )
      onUpdated()
    }
  }
  return (
    <ManagementDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={tr('知识检索设置', 'Knowledge search settings')}
      description={tr(
        '配置语义检索专用模型。保存时先验证并重建独立索引，成功后切换；失败保留当前配置。',
        'Configure the embedding model. Saving validates and builds a separate index before switching; failures preserve the active configuration.',
      )}
      busy={resource.busy}
      error={resource.error}
      footer={
        <>
          <Button variant="outline" disabled={resource.busy} onClick={onClose}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            disabled={resource.busy || resource.loading || !resource.data}
            onClick={() => void save()}
          >
            {resource.busy
              ? tr('正在校验与准备…', 'Validating and preparing…')
              : tr('验证并保存', 'Validate and save')}
          </Button>
        </>
      }
    >
      <ResourceState
        loading={resource.loading}
        error=""
        onRetry={resource.reload}
      />
      <FieldLabel title={tr('语义模型来源', 'Embedding source')}>
        <select
          className="h-10 w-full rounded-md border bg-background px-3"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as EmbeddingProfile['kind'])
          }
          disabled={resource.busy}
        >
          <option value="local">
            {tr('本地模型（默认）', 'Local model (default)')}
          </option>
          <option value="openai-compatible">
            {tr('OpenAI 兼容 Embedding', 'OpenAI-compatible embeddings')}
          </option>
        </select>
      </FieldLabel>
      {kind === 'local' ? (
        <div className="space-y-3 rounded-lg border p-3 text-sm">
          <p>bge-small-zh-v1.5 · 512 {tr('维', 'dimensions')} · ONNX</p>
          <p className="text-muted-foreground">
            {tr(
              '资料在本机生成向量。首次使用需准备约 25 MB 固定模型；聊天时不会下载或自动切换到外部供应商。',
              'Embeddings run locally. Prepare the pinned model (~25 MB) once. Chat never downloads models or automatically switches providers.',
            )}
          </p>
          <Button
            variant="outline"
            disabled={resource.busy}
            onClick={() => void prepare()}
          >
            {tr('准备 / 校验本地模型', 'Prepare / verify local model')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          <FieldLabel title={tr('接口基础地址', 'API base URL')}>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://example.com/v1"
              disabled={resource.busy}
            />
          </FieldLabel>
          <FieldLabel title={tr('模型 ID', 'Model ID')}>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={resource.busy}
            />
          </FieldLabel>
          <div className="grid grid-cols-2 gap-4">
            <FieldLabel title={tr('向量维度', 'Dimensions')}>
              <Input
                type="number"
                min={1}
                max={4096}
                value={dimensions}
                onChange={(e) => setDimensions(Number(e.target.value))}
                disabled={resource.busy}
              />
            </FieldLabel>
            <FieldLabel title={tr('模型版本标识', 'Model revision')}>
              <Input
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
                disabled={resource.busy}
              />
            </FieldLabel>
          </div>
          <FieldLabel
            title={tr(
              'API Key（留空保留已有密钥）',
              'API key (leave blank to retain)',
            )}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={resource.busy}
              placeholder={
                resource.data?.profile.apiKeyConfigured
                  ? tr('已配置', 'Configured')
                  : ''
              }
            />
          </FieldLabel>
          <p className="text-xs text-muted-foreground">
            {tr(
              '切换外部模型会向供应商发送平台知识资料。地址必须由部署维护者通过 SUPERDSH_KNOWLEDGE_EMBEDDING_TRUSTED_ORIGINS 明确授予资料外发许可，网页不能修改信任列表；保存还要求模型管理和智能体管理两项权限。私网访问许可需另外配置，不能替代资料外发许可。密钥加密保存。',
              'External embedding sends platform knowledge to the provider. A deployment operator must approve its origin through SUPERDSH_KNOWLEDGE_EMBEDDING_TRUSTED_ORIGINS; the browser cannot edit this trust list. Saving requires both model and agent management permissions. Private-network permission is separate and does not authorize data export. Keys are encrypted.',
            )}
          </p>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </ManagementDialog>
  )
}
