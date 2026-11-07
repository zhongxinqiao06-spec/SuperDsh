'use client'

import * as React from 'react'
import type {
  CapabilityDescriptor,
  ModelAdapter,
  ModelCapability,
  ModelConfiguration,
  ProviderConnection,
} from '@superdsh/core/contracts/platform'
import { apiClient } from '@/lib/api'
import {
  loadStoredSession,
  subscribeSession,
  sessionIdentityRevision,
} from '@/features/auth/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementResource,
} from './controls'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
  useClientPagination,
} from './presentation'

type Catalog = {
  configurations: ModelConfiguration[]
  connections: ProviderConnection[]
  capabilities: CapabilityDescriptor[]
  defaults: {
    capability: ModelCapability
    configurationId: string | null
    revision: number
  }[]
}
const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm'
const arkEndpoints = [
  {
    name: '火山方舟 · 按量 API',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    name: '火山方舟 · Agent Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  },
  {
    name: '火山方舟 · Coding Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  },
]
const adapters: { id: ModelAdapter; name: string; baseUrl: string }[] = [
  {
    id: 'volcengine-ark',
    name: '火山引擎 · 方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    id: 'openai-completions',
    name: 'OpenAI Completions / Images 兼容',
    baseUrl: 'https://api.deepseek.com',
  },
  { id: 'openai-responses', name: 'OpenAI Responses 兼容', baseUrl: '' },
  { id: 'anthropic-messages', name: 'Anthropic Messages 兼容', baseUrl: '' },
  {
    id: 'volcengine-speech',
    name: '火山引擎 · 豆包语音（尚未实现）',
    baseUrl: 'https://openspeech.bytedance.com',
  },
]
const blankConnection = (): Omit<
  ProviderConnection,
  'id' | 'credentialConfigured' | 'scope'
> & { id?: string; apiKey: string } => ({
  name: '火山方舟',
  adapter: 'volcengine-ark',
  baseUrl: adapters[0]!.baseUrl,
  region: 'cn-beijing',
  enabled: true,
  revision: 1,
  apiKey: '',
})
export function ModelConfigurationsPanel({
  kind = 'chat',
}: {
  kind?: 'chat' | 'multimodal'
}) {
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  return (
    <ScopedModelConfigurationsPanel
      key={`${session?.userId}:${sessionIdentityRevision()}`}
      kind={kind}
    />
  )
}

function ScopedModelConfigurationsPanel({
  kind,
}: {
  kind: 'chat' | 'multimodal'
}) {
  const resource = useManagementResource('model-configurations', () =>
    apiClient.get<Catalog>('/admin/models/configurations'),
  )
  const [search, setSearch] = React.useState('')
  const [connectionsOpen, setConnectionsOpen] = React.useState(false)
  const [connection, setConnection] = React.useState<ReturnType<
    typeof blankConnection
  > | null>(null)
  const [draft, setDraft] = React.useState<ModelConfiguration | null>(null)
  const [notice, setNotice] = React.useState('')
  const data = resource.data
  const entries = (data?.configurations ?? []).filter(
    (item) =>
      item.kind === kind &&
      `${item.name} ${item.modelId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const pages = useClientPagination(entries, kind + search)
  const connectionPages = useClientPagination(data?.connections ?? [])
  const descriptor = data?.capabilities.find(
    (item) => item.id === draft?.capability,
  )
  const parameterProperties = (descriptor?.configurationSchema.properties ??
    {}) as Record<
    string,
    {
      type?: string
      title?: string
      default?: unknown
      minimum?: number
      maximum?: number
      enum?: string[]
      'x-superdsh-adapters'?: string[]
      'x-superdsh-legacy-default'?: unknown
    }
  >
  const save = async () => {
    if (!draft) return
    if (
      await resource.perform(() =>
        draft.id
          ? apiClient.patch(
              '/admin/models/configurations/' + encodeURIComponent(draft.id),
              { ...draft },
            )
          : apiClient.post('/admin/models/configurations', { ...draft }),
      )
    )
      setDraft(null)
  }
  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {kind === 'chat' ? '聊天模型' : '多模态模型'}
          </h2>
          <p className="text-sm text-muted-foreground">
            供应商连接共享；默认值在新会话绑定时生效，已有方案保留配置版本。
          </p>
        </div>
        <Button variant="outline" onClick={() => setConnectionsOpen(true)}>
          供应商连接
        </Button>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      />
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="flex gap-3">
        <Input
          aria-label="搜索模型"
          placeholder="搜索名称或模型 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          onClick={() =>
            setDraft({
              id: '',
              name: '',
              kind,
              capability: kind === 'chat' ? 'chat' : 'image.generate',
              connectionId: data?.connections[0]?.id || '',
              modelId: '',
              revision: 1,
              enabled: true,
              parameters: {},
              roleIds: [],
            })
          }
        >
          新增配置
        </Button>
      </div>
      <ManagementList
        pagination={
          <ManagementPagination
            page={pages.page}
            pageSize={pages.pageSize}
            total={pages.total}
            onPageChange={pages.setPage}
            onPageSizeChange={pages.setPageSize}
          />
        }
      >
        <table className={tableClass}>
          <thead>
            <tr>
              <th>配置 / 供应商</th>
              <th>能力 / 模型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pages.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <p className="text-xs text-muted-foreground">
                    {
                      data?.connections.find(
                        (entry) => entry.id === item.connectionId,
                      )?.name
                    }{' '}
                    · v{item.revision}
                  </p>
                </td>
                <td>
                  {
                    data?.capabilities.find(
                      (entry) => entry.id === item.capability,
                    )?.name
                  }
                  <p className="text-xs">{item.modelId}</p>
                </td>
                <td>
                  {item.enabled ? '启用' : '停用'}
                  {data?.defaults.some(
                    (entry) => entry.configurationId === item.id,
                  ) && ' · 默认'}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDraft(item)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resource.busy || !item.enabled}
                      onClick={() =>
                        void resource.perform(async () => {
                          const result = await apiClient.post<{ note: string }>(
                            `/admin/models/configurations/${encodeURIComponent(item.id)}/verify`,
                            {},
                          )
                          setNotice(result.note)
                        })
                      }
                    >
                      测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resource.busy || !item.enabled}
                      onClick={() =>
                        void resource.perform(() =>
                          apiClient.put(
                            '/admin/models/defaults/' +
                              encodeURIComponent(item.capability),
                            {
                              configurationId: item.id,
                              revision:
                                data?.defaults.find(
                                  (entry) =>
                                    entry.capability === item.capability,
                                )?.revision ?? 0,
                            },
                          ),
                        )
                      }
                    >
                      设为默认
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!entries.length && !resource.loading && (
          <p className="p-4 text-sm text-muted-foreground">
            尚无配置。先添加供应商连接，再填写模型或推理接入点 ID。
          </p>
        )}
        {kind === 'multimodal' && (
          <p className="text-sm text-muted-foreground">
            图片生成、参考图编辑和视觉理解已接入。语音、视频、向量化仅保留能力契约，当前不可调用。
          </p>
        )}
      </ManagementList>
      <ManagementDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        title="供应商连接"
        description="仅保存连接信息和加密凭据，列表不会返回 Key。"
        footer={
          <Button onClick={() => setConnection(blankConnection())}>
            新增连接
          </Button>
        }
      >
        {connectionPages.items.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-2 rounded-lg border p-3"
          >
            <div>
              {item.name}
              <p className="text-xs text-muted-foreground">
                {item.adapter} ·{' '}
                {item.credentialConfigured ? '凭据已配置' : '未配置凭据'} ·{' '}
                {item.enabled ? '启用' : '停用'}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setConnection({ ...item, apiKey: '' })}
            >
              编辑
            </Button>
          </div>
        ))}
        <ManagementPagination
          page={connectionPages.page}
          pageSize={connectionPages.pageSize}
          total={connectionPages.total}
          onPageChange={connectionPages.setPage}
          onPageSizeChange={connectionPages.setPageSize}
        />
      </ManagementDialog>
      <ManagementDialog
        open={!!connection}
        onOpenChange={() => setConnection(null)}
        title={connection?.id ? '编辑供应商连接' : '新增供应商连接'}
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={resource.busy}
            onClick={() =>
              void resource.perform(async () => {
                if (!connection) return
                const { apiKey, ...rest } = connection
                const body = { ...rest, ...(apiKey ? { apiKey } : {}) }
                if (connection.id)
                  await apiClient.patch(
                    '/admin/models/connections/' +
                      encodeURIComponent(connection.id),
                    body,
                  )
                else await apiClient.post('/admin/models/connections', body)
                setConnection(null)
              })
            }
          >
            保存
          </Button>
        }
      >
        {connection && (
          <div className="space-y-4">
            <FieldLabel title="服务">
              <select
                className={selectClass}
                disabled={!!connection.id}
                value={connection.adapter}
                onChange={(e) => {
                  const preset = adapters.find(
                    (item) => item.id === e.target.value,
                  )!
                  setConnection({
                    ...connection,
                    adapter: preset.id,
                    name: preset.name,
                    baseUrl: preset.baseUrl,
                  })
                }}
              >
                {adapters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            {connection.adapter === 'volcengine-ark' && (
              <>
                <FieldLabel title="方舟服务入口">
                  <select
                    className={selectClass}
                    value={
                      arkEndpoints.some(
                        (entry) => entry.baseUrl === connection.baseUrl,
                      )
                        ? connection.baseUrl
                        : ''
                    }
                    onChange={(event) => {
                      const preset = arkEndpoints.find(
                        (entry) => entry.baseUrl === event.target.value,
                      )
                      if (preset)
                        setConnection({
                          ...connection,
                          name: preset.name,
                          baseUrl: preset.baseUrl,
                        })
                    }}
                  >
                    <option value="" disabled>
                      自定义地址
                    </option>
                    {arkEndpoints.map((entry) => (
                      <option key={entry.baseUrl} value={entry.baseUrl}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <p className="text-xs text-muted-foreground">
                  Agent Plan 使用专属 Key 和套餐模型名称（如
                  doubao-seed-2.1-pro）；按量 API 使用普通方舟 Key 和对应 Model
                  ID。仅选择地址不会更换 Key 或默认模型。
                </p>
              </>
            )}
            <FieldLabel title="名称">
              <Input
                value={connection.name}
                onChange={(e) =>
                  setConnection({ ...connection, name: e.target.value })
                }
              />
            </FieldLabel>
            <FieldLabel title="API 地址">
              <Input
                value={connection.baseUrl}
                onChange={(e) =>
                  setConnection({ ...connection, baseUrl: e.target.value })
                }
              />
            </FieldLabel>
            <FieldLabel title="API Key（留空保留原值）">
              <Input
                type="password"
                autoComplete="new-password"
                value={connection.apiKey}
                onChange={(e) =>
                  setConnection({ ...connection, apiKey: e.target.value })
                }
              />
            </FieldLabel>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={connection.enabled}
                onChange={(e) =>
                  setConnection({ ...connection, enabled: e.target.checked })
                }
              />
              启用连接
            </label>
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={!!draft}
        onOpenChange={() => setDraft(null)}
        title={draft?.id ? '编辑模型配置' : '新增模型配置'}
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={
              resource.busy ||
              !draft?.connectionId ||
              !draft?.modelId ||
              !draft?.name
            }
            onClick={() => void save()}
          >
            保存新版本
          </Button>
        }
      >
        {draft && (
          <div className="space-y-4">
            <FieldLabel title="名称">
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </FieldLabel>
            <FieldLabel title="供应商连接">
              <select
                className={selectClass}
                disabled={!!draft.id}
                value={draft.connectionId}
                onChange={(e) =>
                  setDraft({ ...draft, connectionId: e.target.value })
                }
              >
                <option value="">请选择</option>
                {data?.connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel title="能力">
              <select
                className={selectClass}
                disabled={!!draft.id}
                value={draft.capability}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    capability: e.target.value as ModelCapability,
                    parameters: {},
                  })
                }
              >
                {data?.capabilities
                  .filter((item) =>
                    kind === 'chat' ? item.id === 'chat' : item.id !== 'chat',
                  )
                  .map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={!item.available}
                    >
                      {item.name}
                      {!item.available && '（不可用）'}
                    </option>
                  ))}
              </select>
            </FieldLabel>
            <FieldLabel title="模型 / 推理接入点 ID">
              <Input
                value={draft.modelId}
                placeholder="填写供应商提供的 model ID 或 ep-…"
                onChange={(e) =>
                  setDraft({ ...draft, modelId: e.target.value })
                }
              />
            </FieldLabel>
            {Object.entries(parameterProperties)
              .filter(([, schema]) => {
                const adapter = data?.connections.find(
                  (item) => item.id === draft.connectionId,
                )?.adapter
                return (
                  !schema['x-superdsh-adapters'] ||
                  (adapter && schema['x-superdsh-adapters'].includes(adapter))
                )
              })
              .map(([key, schema]) => (
                <FieldLabel key={key} title={schema.title || key}>
                  {schema.enum ? (
                    <select
                      className={selectClass}
                      value={String(
                        draft.parameters[key] ??
                          (draft.id
                            ? schema['x-superdsh-legacy-default']
                            : undefined) ??
                          schema.default ??
                          '',
                      )}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          parameters: {
                            ...draft.parameters,
                            [key]: e.target.value,
                          },
                        })
                      }
                    >
                      {schema.enum.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      type={schema.type === 'integer' ? 'number' : 'text'}
                      min={schema.minimum}
                      max={schema.maximum}
                      value={String(draft.parameters[key] ?? '')}
                      placeholder={String(schema.default ?? '')}
                      onChange={(e) => {
                        const parameters = { ...draft.parameters }
                        if (!e.target.value) delete parameters[key]
                        else
                          parameters[key] =
                            schema.type === 'integer'
                              ? Number(e.target.value)
                              : e.target.value
                        setDraft({ ...draft, parameters })
                      }}
                    />
                  )}
                </FieldLabel>
              ))}
            <FieldLabel title="限制角色 ID（逗号分隔，留空遵循模型使用权限）">
              <Input
                value={draft.roleIds.join(',')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    roleIds: e.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </FieldLabel>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              启用配置（停用将阻止已有会话后续调用）
            </label>
            <p className="text-xs text-muted-foreground">
              配置 ID：{draft.id || '保存后自动生成'}。工具可引用此
              ID；不填写时使用对应能力的全局默认。
            </p>
          </div>
        )}
      </ManagementDialog>
    </section>
  )
}

export function MultimodalModelsPanel() {
  return <ModelConfigurationsPanel kind="multimodal" />
}
