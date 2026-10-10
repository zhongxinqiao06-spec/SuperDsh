'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loadStoredSession, subscribeSession } from '@/features/auth/session'
import {
  createProviderDraft,
  type ModelProviderPreset,
} from '@/features/management/model-provider-presets'
import {
  modelsApi,
  personalModelsApi,
  type ModelProtocol,
  type ModelProvider,
  type PlatformModel,
  type ProviderWrite,
} from '@/features/management/models-api'
import {
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'

const blankModel = (): PlatformModel => ({
  modelId: '',
  name: '',
  inputTypes: ['text'],
})
const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm'

export function ModelsPanel({
  scope = 'platform',
}: {
  scope?: 'platform' | 'personal'
}) {
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  const tr = useManagementText()
  if (
    scope === 'personal' &&
    !session?.permissions?.includes('models.personal.manage')
  )
    return (
      <p className="text-sm text-muted-foreground">
        {tr(
          '当前账号没有个人模型配置权限。',
          'This account cannot manage personal models.',
        )}
      </p>
    )
  return (
    <ScopedModelsPanel
      key={JSON.stringify([scope, session?.userId, session?.authzVersion])}
      scope={scope}
    />
  )
}

function ScopedModelsPanel({ scope }: { scope: 'platform' | 'personal' }) {
  const api = scope === 'personal' ? personalModelsApi : modelsApi
  const tr = useManagementText()
  const resource = useManagementResource(
    `${scope}-model-providers`,
    async () => {
      const [providers, defaults] = await Promise.all([
        api.providers(),
        api.defaultSelection(),
      ])
      return { ...providers, ...defaults }
    },
  )
  const [editing, setEditing] = React.useState<ModelProvider | 'new' | null>(
    null,
  )
  const [draft, setDraft] = React.useState<ProviderWrite>(createProviderDraft)
  const [preset, setPreset] = React.useState<ModelProviderPreset>('deepseek')
  const [makeDefault, setMakeDefault] = React.useState(false)
  const [key, setKey] = React.useState('')
  const [clearKey, setClearKey] = React.useState(false)
  const open = (provider: ModelProvider | 'new') => {
    setEditing(provider)
    setKey('')
    setClearKey(false)
    setPreset('deepseek')
    setMakeDefault(provider === 'new' && !resource.data?.selection)
    setDraft(
      provider === 'new'
        ? createProviderDraft()
        : {
            name: provider.name,
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            enabled: provider.enabled,
            models: structuredClone(provider.models),
          },
    )
  }
  const setModel = (index: number, change: Partial<PlatformModel>) =>
    setDraft({
      ...draft,
      models: draft.models.map((model, i) =>
        i === index ? { ...model, ...change } : model,
      ),
    })
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing) return
    const ok = await resource.perform(async () => {
      const saved = await api.save(
        editing === 'new' ? null : editing.providerId,
        {
          ...draft,
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim(),
          models: draft.models.map((model) => ({
            ...model,
            modelId: model.modelId.trim(),
            name: model.name.trim() || model.modelId.trim(),
          })),
          ...(clearKey
            ? { clearApiKey: true }
            : key.trim()
              ? { apiKey: key.trim() }
              : {}),
        },
      )
      // A default-selection failure must not create the provider a second time
      // or retain a key that the server has already stored.
      setEditing(saved)
      setKey('')
      setClearKey(false)
      if (makeDefault && saved.enabled) {
        const model = saved.models[0]
        if (!model)
          throw new Error(
            tr('供应商未返回可用模型。', 'The provider returned no models.'),
          )
        await api.setDefault({
          providerId: saved.providerId,
          modelId: model.modelId,
        })
      }
    })
    if (ok) {
      setEditing(null)
      setKey('')
      setDraft(createProviderDraft())
      setMakeDefault(false)
    }
  }
  const defaultLabel = resource.data?.selection
    ? (resource.data.providers
        .find(
          (provider) =>
            provider.providerId === resource.data?.selection?.providerId,
        )
        ?.models.find(
          (model) => model.modelId === resource.data?.selection?.modelId,
        )?.name ?? resource.data.selection.modelId)
    : tr('未设置', 'Not configured')
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">
            {scope === 'personal'
              ? tr('个人默认模型', 'Personal default model')
              : tr('平台默认模型', 'Platform default model')}
            : {defaultLabel}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {scope === 'personal'
              ? tr(
                  '个人密钥加密保存在服务器，仅用于你的服务端 Agent。未设置个人默认时使用平台默认。',
                  'Personal keys are encrypted on the server for your server Agent. Without a personal default, the platform default is used.',
                )
              : tr(
                  '平台密钥只保存在服务器。用户仍可在自己的设备上配置个人模型。',
                  'Platform credentials stay on the server. Users can configure personal models on their devices.',
                )}
          </p>
        </div>
        <Button
          disabled={resource.loading || resource.busy || !!resource.error}
          onClick={() => open('new')}
        >
          {tr('添加供应商', 'Add provider')}
        </Button>
      </div>
      <ResourceState {...resource} onRetry={resource.reload} />
      {editing && (
        <form
          className="rounded-xl border p-4"
          onSubmit={(event) => void save(event)}
        >
          <fieldset disabled={resource.busy} className="min-w-0 space-y-4">
            <h3 className="font-semibold">
              {editing === 'new'
                ? tr('添加供应商', 'Add provider')
                : tr('编辑供应商', 'Edit provider')}
            </h3>
            {editing === 'new' && (
              <div className="space-y-2">
                <FieldLabel title={tr('供应商', 'Provider')}>
                  <select
                    className={selectClass}
                    value={preset}
                    onChange={(event) => {
                      const next = event.target.value as ModelProviderPreset
                      setPreset(next)
                      setDraft(createProviderDraft(next))
                      setKey('')
                      setClearKey(false)
                    }}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="custom">{tr('自定义', 'Custom')}</option>
                  </select>
                </FieldLabel>
                {preset === 'deepseek' && (
                  <p className="text-sm text-muted-foreground">
                    {tr(
                      '已填入官方接口和模型，只需填写 API Key 后保存。其他参数可以按需调整。',
                      'The official endpoint and models are filled in. Enter your API key and save; other fields can be adjusted if needed.',
                    )}
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldLabel title={tr('名称', 'Name')}>
                <Input
                  required
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </FieldLabel>
              <FieldLabel title={tr('接口协议', 'API protocol')}>
                <select
                  className={selectClass}
                  value={draft.protocol}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      protocol: event.target.value as ModelProtocol,
                    })
                  }
                >
                  <option value="openai-completions">
                    OpenAI Chat Completions
                  </option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </FieldLabel>
              <FieldLabel title={tr('API 基础地址', 'API base URL')}>
                <Input
                  required
                  type="url"
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, baseUrl: event.target.value })
                  }
                />
              </FieldLabel>
              <FieldLabel
                title={tr(
                  'API Key（留空保留原值）',
                  'API key (leave blank to keep existing)',
                )}
              >
                <Input
                  type="password"
                  required={editing === 'new' && preset === 'deepseek'}
                  autoComplete="new-password"
                  disabled={clearKey}
                  placeholder={
                    editing !== 'new' && editing.apiKeyConfigured
                      ? tr(
                          '已配置，密钥不会回显',
                          'Configured — value is never returned',
                        )
                      : tr('未配置', 'Not configured')
                  }
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </FieldLabel>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, enabled: event.target.checked })
                  }
                />
                {tr('启用供应商', 'Enable provider')}
              </label>
              {(editing === 'new' || makeDefault) && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    disabled={!draft.enabled}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                  />
                  {tr('设为默认模型', 'Set as default model')}
                  {makeDefault && (
                    <span className="text-muted-foreground">
                      · {draft.models[0]?.name || draft.models[0]?.modelId}
                    </span>
                  )}
                </label>
              )}
              {editing !== 'new' && editing.apiKeyConfigured && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(event) => {
                      setClearKey(event.target.checked)
                      setKey('')
                    }}
                  />
                  {tr('清除已保存的密钥', 'Remove stored key')}
                </label>
              )}
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-3 font-medium">
                {tr('模型列表', 'Models')}
              </legend>
              {draft.models.map((model, index) => (
                <div
                  key={index}
                  className="grid gap-3 rounded-lg bg-muted/50 p-3 sm:grid-cols-2 lg:grid-cols-4"
                >
                  <FieldLabel title="Model ID">
                    <Input
                      required
                      value={model.modelId}
                      onChange={(event) =>
                        setModel(index, { modelId: event.target.value })
                      }
                    />
                  </FieldLabel>
                  <FieldLabel title={tr('显示名称', 'Display name')}>
                    <Input
                      value={model.name}
                      onChange={(event) =>
                        setModel(index, { name: event.target.value })
                      }
                    />
                  </FieldLabel>
                  <FieldLabel
                    title={tr(
                      '上下文上限（可选）',
                      'Context window (optional)',
                    )}
                  >
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={model.contextWindow ?? ''}
                      onChange={(event) =>
                        setModel(index, {
                          contextWindow: event.target.value
                            ? Number(event.target.value)
                            : null,
                        })
                      }
                    />
                  </FieldLabel>
                  <FieldLabel
                    title={tr(
                      '最大输出（可选）',
                      'Max output tokens (optional)',
                    )}
                  >
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={model.maxTokens ?? ''}
                      onChange={(event) =>
                        setModel(index, {
                          maxTokens: event.target.value
                            ? Number(event.target.value)
                            : null,
                        })
                      }
                    />
                  </FieldLabel>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={model.inputTypes?.includes('image') ?? false}
                      onChange={(event) =>
                        setModel(index, {
                          inputTypes: event.target.checked
                            ? ['text', 'image']
                            : ['text'],
                        })
                      }
                    />
                    {tr('支持图片输入', 'Image input')}
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={draft.models.length < 2}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        models: draft.models.filter((_, i) => i !== index),
                      })
                    }
                  >
                    {tr('移除模型', 'Remove model')}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDraft({
                    ...draft,
                    models: [...draft.models, blankModel()],
                  })
                }
              >
                {tr('添加模型', 'Add model')}
              </Button>
            </fieldset>
            <div className="flex gap-2">
              <Button
                disabled={
                  resource.busy ||
                  (editing === 'new' && preset === 'deepseek' && !key.trim())
                }
                type="submit"
              >
                {tr('保存', 'Save')}
              </Button>
              <Button
                disabled={resource.busy}
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(null)
                  setKey('')
                  setDraft(createProviderDraft())
                  setMakeDefault(false)
                }}
              >
                {tr('取消', 'Cancel')}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {resource.data?.providers.map((provider) => (
        <section
          key={provider.providerId}
          className="overflow-hidden rounded-xl border"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h3 className="font-semibold">
                {provider.name}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  {provider.enabled
                    ? tr('已启用', 'Enabled')
                    : tr('已停用', 'Disabled')}
                </span>
              </h3>
              <p className="break-all text-xs text-muted-foreground">
                {provider.protocol} · {provider.baseUrl}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {provider.apiKeyConfigured
                  ? tr('密钥已配置', 'API key configured')
                  : tr('未配置密钥', 'No API key configured')}
              </p>
            </div>
            <div className="flex gap-2">
              {scope === 'personal' && (
                <Button
                  disabled={resource.busy || !provider.enabled}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void resource.perform(() => api.verify(provider.providerId))
                  }
                >
                  {tr('验证连接', 'Verify connection')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={resource.busy}
                onClick={() => open(provider)}
              >
                {tr('编辑', 'Edit')}
              </Button>
              <Button
                disabled={resource.busy}
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      tr(
                        `删除供应商 ${provider.name} 及其模型？`,
                        `Delete provider ${provider.name} and its models?`,
                      ),
                    )
                  )
                    void resource.perform(() => api.remove(provider.providerId))
                }}
              >
                {tr('删除', 'Delete')}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>{tr('模型', 'Model')}</th>
                  <th>{tr('上下文 / 输出', 'Context / output')}</th>
                  <th>{tr('输入', 'Input')}</th>
                  <th>{tr('默认设置', 'Default')}</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model) => {
                  const isDefault =
                    resource.data?.selection?.providerId ===
                      provider.providerId &&
                    resource.data.selection.modelId === model.modelId
                  return (
                    <tr key={model.modelId}>
                      <td>
                        {model.name}
                        <div className="text-xs text-muted-foreground">
                          {model.modelId}
                        </div>
                      </td>
                      <td>
                        {model.contextWindow ?? '—'} / {model.maxTokens ?? '—'}
                      </td>
                      <td>{(model.inputTypes ?? ['text']).join(', ')}</td>
                      <td>
                        {isDefault ? (
                          <span>{tr('当前默认', 'Current default')}</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resource.busy || !provider.enabled}
                            onClick={() =>
                              void resource.perform(() =>
                                api.setDefault({
                                  providerId: provider.providerId,
                                  modelId: model.modelId,
                                }),
                              )
                            }
                          >
                            {tr('设为默认', 'Set default')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {!resource.loading && !resource.data?.providers.length && (
        <p className="rounded-xl border p-6 text-sm text-muted-foreground">
          {scope === 'personal'
            ? tr(
                '添加个人供应商和模型，即可在服务端 Agent 中使用，无需连接电脑。',
                'Add a personal provider and model to use the server Agent without a computer.',
              )
            : tr(
                '尚未配置平台供应商。添加供应商与模型后，选择平台默认模型。',
                'No platform providers yet. Add a provider and models, then select a platform default.',
              )}
        </p>
      )}
      {resource.data?.selection && (
        <Button
          disabled={resource.busy}
          variant="outline"
          onClick={() => void resource.perform(() => api.setDefault(null))}
        >
          {scope === 'personal'
            ? tr('使用平台默认模型', 'Use platform default')
            : tr('清除平台默认模型', 'Clear platform default')}
        </Button>
      )}
    </div>
  )
}
