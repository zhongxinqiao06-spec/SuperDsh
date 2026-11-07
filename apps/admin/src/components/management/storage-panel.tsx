'use client'
import * as React from 'react'
import type { StoragePolicy } from '@superdsh/core/contracts/platform'
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
type Connection = {
  id: string
  name: string
  backend: string
  configuration: {
    backend: string
    endpoint?: string
    bucket?: string
    region?: string
    prefix?: string
    virtualHostStyle?: boolean
  }
  credentialConfigured: boolean
  revision: number
  enabled: boolean
}
type Settings = {
  activeConnectionId: string
  revision: number
  policy: StoragePolicy
  connections: Connection[]
  usage: { storage_id: string; objects: string; bytes: string }[]
  migrations: { state: string; total: string }[]
}
export function StoragePanel() {
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  return (
    <ScopedStoragePanel
      key={`${session?.userId}:${sessionIdentityRevision()}`}
    />
  )
}

function ScopedStoragePanel() {
  const resource = useManagementResource('storage', async () => {
    const [settings, usage, migrations] = await Promise.all([
      apiClient.get<Settings>('/admin/storage'),
      apiClient.get<{ items: Settings['usage'] }>('/admin/storage/usage'),
      apiClient.get<{ items: Settings['migrations'] }>(
        '/admin/storage/migrations',
      ),
    ])
    return { ...settings, usage: usage.items, migrations: migrations.items }
  })
  const [draft, setDraft] = React.useState<Connection | null>(null),
    [accessKey, setAccessKey] = React.useState(''),
    [secretKey, setSecretKey] = React.useState(''),
    [settings, setSettings] = React.useState<Settings | null>(null),
    [notice, setNotice] = React.useState('')
  const pages = useClientPagination(resource.data?.connections ?? [])
  const open = (item?: Connection) => {
    setAccessKey('')
    setSecretKey('')
    setDraft(
      item ?? {
        id: '',
        name: 'MinIO',
        backend: 's3',
        configuration: {
          backend: 's3',
          endpoint: 'http://127.0.0.1:19000',
          bucket: 'superdsh-files',
          region: 'us-east-1',
          prefix: '',
          virtualHostStyle: false,
        },
        enabled: true,
        revision: 1,
        credentialConfigured: false,
      },
    )
  }
  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">文件存储</h2>
          <p className="text-sm text-muted-foreground">
            管理存储连接和保留策略；存储权限不授予读取其他账号文件的权限。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!resource.data}
            onClick={() => setSettings(resource.data)}
          >
            策略与默认存储
          </Button>
          <Button onClick={() => open()}>新增连接</Button>
        </div>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      />
      {notice && <p role="status">{notice}</p>}
      <p className="text-sm text-muted-foreground">
        已登记文件{' '}
        {resource.data?.usage.reduce(
          (n, item) => n + Number(item.objects),
          0,
        ) || 0}{' '}
        个 ·{' '}
        {(
          (resource.data?.usage.reduce(
            (n, item) => n + Number(item.bytes),
            0,
          ) || 0) /
          1024 /
          1024
        ).toFixed(1)}{' '}
        MiB（元数据统计，不含源备份或桶内其他对象）
      </p>
      {!!resource.data?.migrations.length && (
        <p className="text-sm">
          迁移记录：
          {resource.data.migrations
            .map((item) => `${item.state} ${item.total}`)
            .join(' · ')}
        </p>
      )}
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
              <th>名称</th>
              <th>存储位置</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pages.items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>
                  {item.backend} · {item.configuration.endpoint || '本地目录'} /{' '}
                  {item.configuration.bucket}
                </td>
                <td>
                  {item.enabled ? '启用' : '停用'}
                  {item.id === resource.data?.activeConnectionId &&
                    ' · 新文件默认'}
                </td>
                <td>
                  <div className="flex gap-2">
                    {item.backend === 's3' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => open(item)}
                      >
                        编辑
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resource.busy}
                      onClick={() =>
                        void resource.perform(async () => {
                          await apiClient.post(
                            `/admin/storage/connections/${encodeURIComponent(item.id)}/check`,
                            {},
                          )
                          setNotice('存储连接正常')
                        })
                      }
                    >
                      检查连接
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ManagementList>
      <ManagementDialog
        open={!!draft}
        onOpenChange={() => setDraft(null)}
        title="存储连接"
        description="已有存储位置不可覆盖。迁移需复制、校验后显式切换；留空凭据保留原值。"
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={resource.busy}
            onClick={() =>
              void resource.perform(async () => {
                if (!draft) return
                const body = {
                  ...draft,
                  ...(accessKey || secretKey
                    ? {
                        credentials: {
                          accessKeyId: accessKey,
                          secretAccessKey: secretKey,
                        },
                      }
                    : {}),
                }
                if (draft.id)
                  await apiClient.patch(
                    `/admin/storage/connections/${encodeURIComponent(draft.id)}`,
                    body,
                  )
                else await apiClient.post('/admin/storage/connections', body)
                setDraft(null)
                setAccessKey('')
                setSecretKey('')
              })
            }
          >
            保存
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
            {(['endpoint', 'bucket', 'region'] as const).map((key) => (
              <FieldLabel key={key} title={key}>
                <Input
                  disabled={!!draft.id}
                  value={draft.configuration[key] || ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      configuration: {
                        ...draft.configuration,
                        [key]: e.target.value,
                      },
                    })
                  }
                />
              </FieldLabel>
            ))}
            <FieldLabel title="Access Key">
              <Input
                autoComplete="off"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
              />
            </FieldLabel>
            <FieldLabel title="Secret Key">
              <Input
                type="password"
                autoComplete="new-password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
              />
            </FieldLabel>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              允许新文件写入
            </label>
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={!!settings}
        onOpenChange={() => setSettings(null)}
        title="文件策略"
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={resource.busy}
            onClick={() =>
              void resource.perform(async () => {
                await apiClient.put('/admin/storage', settings!)
                setSettings(null)
              })
            }
          >
            检查并保存
          </Button>
        }
      >
        {settings && (
          <div className="space-y-4">
            <FieldLabel title="新文件默认存储">
              <select
                className="h-9 rounded-md border bg-background px-3"
                value={settings.activeConnectionId}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    activeConnectionId: e.target.value,
                  })
                }
              >
                {settings.connections
                  .filter((item) => item.enabled)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </FieldLabel>
            {(
              [
                ['maxFileBytes', '上传上限（字节）'],
                ['temporaryHours', '暂存保留（小时）'],
                ['recycleDays', '回收站保留（天）'],
              ] as const
            ).map(([key, title]) => (
              <FieldLabel key={key} title={title}>
                <Input
                  type="number"
                  min={1}
                  value={settings.policy[key]}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      policy: {
                        ...settings.policy,
                        [key]: Number(e.target.value),
                      },
                    })
                  }
                />
              </FieldLabel>
            ))}
            <p className="text-xs text-muted-foreground">
              只改变新上传位置；原文件通过位置映射继续读取，迁移需运行维护命令。
            </p>
          </div>
        )}
      </ManagementDialog>
    </section>
  )
}
