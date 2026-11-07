'use client'

import * as React from 'react'
import type {
  ExtensionSource,
  ToolImplementation,
} from '@superdsh/core/contracts/extensions'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { extensionsApi } from '@/features/agents/extensions-api'
import {
  FieldLabel,
  ResourceState,
  selectClass,
  tableClass,
  useManagementResource,
} from './controls'
import { ManagementDialog, ManagementPagination } from './presentation'

async function base64(file: File) {
  if (file.size > 16 * 1024 * 1024) throw new Error('扩展 ZIP 不能超过 16 MiB')
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('无法读取扩展包'))
    reader.readAsDataURL(file)
  })
}
const blank = () => ({
  id: '',
  name: '',
  endpoint: '',
  token: '',
  version: '1.0.0',
})

export function ToolSourcesDialog({
  onClose,
  onUpdated,
}: {
  onClose(): void
  onUpdated(): void
}) {
  const { can } = useAuth()
  const resource = useManagementResource(
    'extension-sources',
    extensionsApi.list,
  )
  const [page, setPage] = React.useState(1),
    [pageSize, setPageSize] = React.useState(10)
  const [install, setInstall] = React.useState<ExtensionSource | 'new' | null>(
    null,
  )
  const [file, setFile] = React.useState<File | null>(null)
  const [editing, setEditing] = React.useState<ExtensionSource | 'new' | null>(
    null,
  )
  const [draft, setDraft] = React.useState(blank)
  const [discovered, setDiscovered] = React.useState<{
    tools: ToolImplementation[]
    discoveryDigest: string
  } | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [activation, setActivation] = React.useState<ExtensionSource | null>(
    null,
  )
  const [version, setVersion] = React.useState('')
  const all = resource.data?.items ?? []
  const openMcp = (source: ExtensionSource | 'new') => {
    setEditing(source)
    setDraft(
      source === 'new'
        ? blank()
        : {
            id: source.id,
            name: source.name,
            endpoint: source.endpoint || '',
            token: '',
            version: source.activeVersion,
          },
    )
    setDiscovered(null)
    setSelected(source === 'new' ? [] : source.tools.map((tool) => tool.id))
  }
  const changed = () => {
    resource.reload()
    onUpdated()
  }
  return (
    <>
      <ManagementDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title="扩展来源与 MCP"
        description="工具配置引用已安装的实现版本。启停立即影响后续调用；升级和回滚用于之后新建的工具配置，已绑定会话保留原版本。"
        className="sm:max-w-5xl"
        busy={resource.busy}
      >
        <div className="flex justify-end gap-2">
          {can('extensions.manage') && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setInstall('new')
                  setFile(null)
                }}
              >
                安装扩展包
              </Button>
              <Button onClick={() => openMcp('new')}>连接 MCP</Button>
            </>
          )}
        </div>
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          onRetry={resource.reload}
        />
        <div className="overflow-x-auto rounded-xl border">
          <table className={tableClass}>
            <thead>
              <tr>
                <th>来源</th>
                <th>当前版本与状态</th>
                <th>已授权工具</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {all
                .slice((page - 1) * pageSize, page * pageSize)
                .map((source) => (
                  <tr key={source.id}>
                    <td>
                      <p>{source.name}</p>
                      <code className="text-xs text-muted-foreground">
                        {source.id} · {source.kind}
                      </code>
                    </td>
                    <td>
                      {source.activeVersion} ·{' '}
                      {source.enabled
                        ? source.status === 'ready'
                          ? '可用'
                          : '需检查'
                        : '已停用'}
                      {source.diagnostic && (
                        <p className="text-xs text-destructive">
                          {source.diagnostic}
                        </p>
                      )}
                    </td>
                    <td>
                      {source.tools.length} 个
                      {source.credentialConfigured && (
                        <p className="text-xs text-muted-foreground">
                          凭据已设置
                        </p>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {source.kind !== 'builtin' &&
                          can('extensions.manage') && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resource.busy}
                                onClick={() =>
                                  void resource.perform(() =>
                                    extensionsApi.check(source),
                                  )
                                }
                              >
                                检查连接
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resource.busy}
                                onClick={async () => {
                                  if (
                                    await resource.perform(() =>
                                      extensionsApi.update(
                                        source,
                                        !source.enabled,
                                      ),
                                    )
                                  )
                                    changed()
                                }}
                              >
                                {source.enabled ? '停用' : '启用'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  source.kind === 'package'
                                    ? (setInstall(source), setFile(null))
                                    : openMcp(source)
                                }
                              >
                                {source.kind === 'package'
                                  ? '安装新版本'
                                  : '检查与更新'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setActivation(source)
                                  setVersion(source.activeVersion)
                                }}
                              >
                                版本与回滚
                              </Button>
                            </>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <ManagementPagination
          page={page}
          pageSize={pageSize}
          total={all.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
          loading={resource.loading}
        />
      </ManagementDialog>
      <ManagementDialog
        open={!!install}
        onOpenChange={(open) => !open && setInstall(null)}
        title={install === 'new' ? '安装扩展包' : '安装扩展新版本'}
        description="上传含 superdsh-extension.json 的 ZIP。可执行扩展属于受信任的服务端代码，安装权限与资源编辑权限独立；健康检查失败不会替换当前版本。"
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={!file || resource.busy}
            onClick={async () => {
              if (!file || !install) return
              if (
                await resource.perform(async () =>
                  extensionsApi.install(
                    await base64(file),
                    install === 'new' ? undefined : install.revision,
                    install === 'new' ? undefined : install.id,
                  ),
                )
              ) {
                setInstall(null)
                setFile(null)
                changed()
              }
            }}
          >
            {resource.busy ? '准备依赖并检查…' : '安装并检查'}
          </Button>
        }
      >
        <Input
          type="file"
          accept=".zip"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </ManagementDialog>
      <ManagementDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title="连接与授权 MCP 工具"
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy || !draft.endpoint}
              onClick={async () => {
                let result: typeof discovered = null
                if (
                  await resource.perform(async () => {
                    result = await extensionsApi.discover(
                      draft.endpoint,
                      draft.token || undefined,
                      editing === 'new' ? undefined : editing?.id,
                    )
                  })
                ) {
                  setDiscovered(result)
                  setSelected([])
                }
              }}
            >
              检查连接与发现工具
            </Button>
            <Button
              disabled={
                resource.busy ||
                !discovered ||
                !selected.length ||
                !draft.id ||
                !draft.name
              }
              onClick={async () => {
                if (!discovered || !editing) return
                if (
                  await resource.perform(() =>
                    extensionsApi.connect({
                      ...draft,
                      token: draft.token || undefined,
                      selectedToolIds: selected,
                      discoveryDigest: discovered.discoveryDigest,
                      revision:
                        editing === 'new' ? undefined : editing.revision,
                    }),
                  )
                ) {
                  setEditing(null)
                  setDraft(blank())
                  changed()
                }
              }}
            >
              保存所选工具
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {(['id', 'name', 'endpoint', 'version', 'token'] as const).map(
            (key) => (
              <FieldLabel
                key={key}
                title={
                  {
                    id: '稳定标识',
                    name: '名称',
                    endpoint: 'Streamable HTTP 地址',
                    version: '配置版本',
                    token: '访问令牌（只写入）',
                  }[key]
                }
              >
                <Input
                  type={key === 'token' ? 'password' : 'text'}
                  autoComplete={key === 'token' ? 'new-password' : undefined}
                  value={draft[key]}
                  disabled={
                    editing !== 'new' && (key === 'id' || key === 'endpoint')
                  }
                  onChange={(event) => {
                    setDraft({ ...draft, [key]: event.target.value })
                    if (key === 'endpoint' || key === 'token')
                      setDiscovered(null)
                  }}
                />
              </FieldLabel>
            ),
          )}
        </div>
        {discovered && (
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-sm text-muted-foreground">
              只允许所选工具，后续发现新工具不会自动授权。内容改变时需使用新版本号。
            </p>
            {discovered.tools.map((tool) => (
              <label
                key={tool.id}
                className="flex items-start gap-2 rounded-lg p-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(tool.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, tool.id]
                        : selected.filter((id) => id !== tool.id),
                    )
                  }
                />
                <span>
                  {tool.name}
                  <span className="block text-xs text-muted-foreground">
                    {tool.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={!!activation}
        onOpenChange={(open) => !open && setActivation(null)}
        title="选择已安装版本"
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={resource.busy || !activation || !version}
            onClick={async () => {
              if (
                activation &&
                (await resource.perform(() =>
                  extensionsApi.update(activation, activation.enabled, version),
                ))
              ) {
                setActivation(null)
                changed()
              }
            }}
          >
            激活所选版本
          </Button>
        }
      >
        <select
          className={selectClass}
          aria-label="已安装版本"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
        >
          {activation?.versions.map((item) => (
            <option value={item.version} key={item.version}>
              {item.version} · {item.digest.slice(0, 12)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          已有绑定继续引用原版本，版本内容不能被覆盖或物理删除。
        </p>
      </ManagementDialog>
    </>
  )
}
