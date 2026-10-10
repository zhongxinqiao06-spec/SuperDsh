import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { PlatformSelect } from './PlatformSelect.tsx'
import { object, rows, string, type Row } from './platform-model.ts'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'

const protocols = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]

/** Personal credentials are write-only and belong to the selected platform account. */
export function PersonalModels({ model }: { model: PlatformWorkspaceModel }) {
  if (!model.account?.user?.permissions.includes('models.personal.manage'))
    return null
  return (
    <ScopedPersonalModels
      key={`${model.account?.identityKey}:${model.account?.identityGeneration}`}
      model={model}
    />
  )
}

function ScopedPersonalModels({ model }: { model: PlatformWorkspaceModel }) {
  const [providers, setProviders] = useState<Row[]>([])
  const [selection, setSelection] = useState<Row>({})
  const [editing, setEditing] = useState<Row | null>(null)
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelIds, setModelIds] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [version, setVersion] = useState(0)
  const [status, setStatus] = useState('')
  useEffect(() => {
    setEditing(null)
    setApiKey('')
    setStatus('')
    setProviders([])
    setSelection({})
    let disposed = false
    void Promise.all([
      model.request({ operation: 'personal-providers' }),
      model.request({ operation: 'personal-default' }),
    ])
      .then(([result, defaults]) => {
        if (!disposed) {
          setProviders(rows(object(result).providers))
          setSelection(object(object(defaults).selection))
        }
      })
      .catch((reason) => {
        if (!disposed) setStatus(String(reason))
      })
    return () => {
      disposed = true
    }
  }, [model.request, version])
  const open = (provider: Row) => {
    setEditing(provider)
    setName(string(provider.name))
    setProtocol(string(provider.protocol) || 'openai-completions')
    setBaseUrl(string(provider.baseUrl))
    setModelIds(
      rows(provider.models)
        .map((value) => string(value.modelId))
        .join(', '),
    )
    setApiKey('')
    setStatus('')
  }
  return (
    <section className="platformLoginForm" aria-label="个人模型">
      <h3>个人模型 · 服务端 Agent</h3>
      <p>
        密钥加密保存在当前平台，只用于你的服务端
        Agent。本机个人模型配置保持独立。
      </p>
      {status && <p role="status">{status}</p>}
      {providers.map((provider) => (
        <div
          key={string(provider.providerId)}
          className="platformPersonalProvider"
        >
          <strong>{string(provider.name)}</strong>
          <p>
            {provider.apiKeyConfigured ? '密钥已配置' : '未配置密钥'} ·{' '}
            {string(provider.protocol)}
          </p>
          <div className="productDeviceControls">
            <Button
              size="sm"
              disabled={model.busy}
              onClick={() => open(provider)}
            >
              编辑
            </Button>
            <Button
              size="sm"
              disabled={model.busy}
              onClick={() =>
                void model.run(async () => {
                  await model.request({
                    operation: 'verify-personal-provider',
                    providerId: string(provider.providerId),
                  })
                  setStatus('连接验证成功')
                })
              }
            >
              验证连接
            </Button>
            <Button
              size="sm"
              disabled={model.busy}
              onClick={() => {
                if (!window.confirm('删除该个人供应商及其模型？')) return
                void model.run(async () => {
                  await model.request({
                    operation: 'delete-personal-provider',
                    providerId: string(provider.providerId),
                  })
                  setVersion((value) => value + 1)
                })
              }}
            >
              删除
            </Button>
          </div>
          {rows(provider.models).map((entry) => (
            <Button
              key={string(entry.modelId)}
              size="sm"
              disabled={model.busy || provider.enabled === false}
              onClick={() =>
                void model.run(async () => {
                  await model.request({
                    operation: 'set-personal-default',
                    body: {
                      selection: {
                        providerId: string(provider.providerId),
                        modelId: string(entry.modelId),
                      },
                    },
                  })
                  setVersion((value) => value + 1)
                })
              }
            >
              {selection.providerId === provider.providerId &&
              selection.modelId === entry.modelId
                ? '当前默认：'
                : '设为默认：'}
              {string(entry.name) || string(entry.modelId)}
            </Button>
          ))}
        </div>
      ))}
      <div className="productDeviceControls">
        <Button size="sm" onClick={() => open({})}>
          添加供应商
        </Button>
        <Button
          size="sm"
          disabled={model.busy}
          onClick={() =>
            void model.run(async () => {
              await model.request({
                operation: 'set-personal-default',
                body: { selection: null },
              })
              setVersion((value) => value + 1)
            })
          }
        >
          使用平台默认
        </Button>
      </div>
      {editing && (
        <form
          className="platformLoginForm"
          onSubmit={(event) => {
            event.preventDefault()
            const secret = apiKey
            setApiKey('')
            const providerId = string(editing.providerId)
            const entries = [
              ...new Set(
                modelIds
                  .split(/[,，\n]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ]
            void model.run(async () => {
              if (!entries.length) throw new Error('请填写模型 ID')
              await model.request({
                operation: providerId
                  ? 'update-personal-provider'
                  : 'create-personal-provider',
                providerId,
                body: {
                  name: name.trim(),
                  protocol,
                  baseUrl: baseUrl.trim(),
                  enabled: editing.enabled !== false,
                  models: entries.map((id) => ({
                    ...rows(editing.models).find(
                      (entry) => entry.modelId === id,
                    ),
                    modelId: id,
                    name:
                      string(
                        rows(editing.models).find(
                          (entry) => entry.modelId === id,
                        )?.name,
                      ) || id,
                    inputTypes: rows(editing.models).find(
                      (entry) => entry.modelId === id,
                    )?.inputTypes ?? ['text'],
                  })),
                  ...(secret.trim() ? { apiKey: secret.trim() } : {}),
                },
              })
              setVersion((value) => value + 1)
            })
          }}
        >
          <label>
            名称
            <Input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <PlatformSelect
            label="接口协议"
            value={protocol}
            options={protocols}
            onChange={setProtocol}
          />
          <label>
            API 基础地址
            <Input
              type="url"
              required
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            模型 ID（多个用逗号分隔）
            <Input
              required
              value={modelIds}
              onChange={(event) => setModelIds(event.target.value)}
            />
          </label>
          <label>
            API Key（留空保留原值）
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <div className="productDeviceControls">
            <Button type="submit" variant="primary" disabled={model.busy}>
              保存
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditing(null)
                setApiKey('')
              }}
            >
              取消
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
