'use client'
import * as React from 'react'
import type { FileEntry } from '@superdsh/core/contracts/platform'
import { apiClient } from '@/lib/api'
import { downloadBlob } from '@/lib/download'
import {
  downloadLibraryFile,
  uploadLibraryFile,
} from '@/features/management/file-library-api'
import {
  loadStoredSession,
  subscribeSession,
  sessionIdentityRevision,
} from '@/features/auth/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResourceState, tableClass, useManagementResource } from './controls'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
} from './presentation'

export function FilesPanel() {
  const active = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  return (
    <ScopedFilesPanel key={`${active?.userId}:${sessionIdentityRevision()}`} />
  )
}

function ScopedFilesPanel() {
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  const [page, setPage] = React.useState(1),
    [pageSize, setPageSize] = React.useState(10),
    [search, setSearch] = React.useState(''),
    [trash, setTrash] = React.useState(false)
  const [uploadOpen, setUploadOpen] = React.useState(false),
    [selected, setSelected] = React.useState<File | null>(null),
    [message, setMessage] = React.useState('')
  const [versions, setVersions] = React.useState<FileEntry[] | null>(null)
  const [previous, setPrevious] = React.useState<FileEntry | null>(null)
  const controller = React.useRef<AbortController | null>(null)
  const resource = useManagementResource(
    `files:${page}:${pageSize}:${search}:${trash}`,
    () =>
      apiClient.get<{ items: FileEntry[]; total: number }>('/files', {
        query: { page, pageSize, q: search, trash },
      }),
  )
  React.useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    return () => abort.abort()
  }, [session?.userId])
  const canWrite = session?.permissions?.includes('files.write')
  const download = (item: FileEntry) =>
    resource.perform(async () =>
      downloadBlob(
        await downloadLibraryFile(item, controller.current!.signal),
        item.name,
      ),
    )
  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">我的文件</h2>
        <p className="text-sm text-muted-foreground">
          明确上传的资料、会话素材与成果。设备目录和本地 Home 不会自动上传。
        </p>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      />
      <div className="flex gap-3">
        <Input
          placeholder="搜索文件名"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
        <Button
          variant="outline"
          onClick={() => {
            setTrash(!trash)
            setPage(1)
          }}
        >
          {trash ? '返回文件' : '回收站'}
        </Button>
        {canWrite && (
          <Button onClick={() => setUploadOpen(true)}>上传文件</Button>
        )}
      </div>
      <ManagementList
        pagination={
          <ManagementPagination
            page={page}
            pageSize={pageSize}
            total={resource.data?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value)
              setPage(1)
            }}
          />
        }
      >
        <table className={tableClass}>
          <thead>
            <tr>
              <th>文件名</th>
              <th>类型 / 大小</th>
              <th>版本 / 引用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>
                  {item.mediaType}
                  <p className="text-xs text-muted-foreground">
                    {(item.size / 1024).toFixed(1)} KiB
                  </p>
                </td>
                <td>
                  v{item.version} · {item.references.length} 处引用
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {!trash && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={resource.busy}
                        onClick={() => void download(item)}
                      >
                        下载
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void resource.perform(async () =>
                          setVersions(
                            (
                              await apiClient.get<{ items: FileEntry[] }>(
                                `/files/${encodeURIComponent(item.id)}/versions`,
                              )
                            ).items,
                          ),
                        )
                      }
                    >
                      版本
                    </Button>
                    {canWrite && !trash && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPrevious(item)
                          setUploadOpen(true)
                        }}
                      >
                        上传新版
                      </Button>
                    )}
                    {canWrite && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          resource.busy || (!trash && !!item.references.length)
                        }
                        onClick={() =>
                          void resource.perform(() =>
                            apiClient.post(
                              `/files/${encodeURIComponent(item.id)}/${trash ? 'restore' : 'trash'}`,
                              {},
                            ),
                          )
                        }
                      >
                        {trash ? '恢复' : '移到回收站'}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.loading && !resource.data?.items.length && (
          <p className="p-4 text-sm text-muted-foreground">暂无文件。</p>
        )}
      </ManagementList>
      <ManagementDialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open) {
            setSelected(null)
            setPrevious(null)
          }
        }}
        title={previous ? `上传新版 · ${previous.name}` : '上传文件'}
        description="中断后重新选择同一文件可继续上传。文件完成大小、类型和哈希校验后才会可用。"
        busy={resource.busy}
        error={resource.error}
        footer={
          <Button
            disabled={!selected || resource.busy}
            onClick={() =>
              void resource.perform(async () => {
                if (!selected) return
                await uploadLibraryFile(
                  selected,
                  controller.current!.signal,
                  setMessage,
                  previous?.id,
                )
                setUploadOpen(false)
                setSelected(null)
                setPrevious(null)
              })
            }
          >
            开始上传
          </Button>
        }
      >
        <Input
          type="file"
          onChange={(e) => setSelected(e.target.files?.[0] || null)}
        />
        <p role="status" className="text-sm">
          {message}
        </p>
      </ManagementDialog>
      <ManagementDialog
        open={!!versions}
        onOpenChange={() => setVersions(null)}
        title="文件版本"
      >
        {versions?.map((item) => (
          <div
            key={item.id}
            className="flex justify-between gap-2 border-b py-3"
          >
            <span>
              v{item.version} · {item.name}
            </span>
            <Button
              variant="outline"
              disabled={!!item.deletedAt || resource.busy}
              onClick={() => void download(item)}
            >
              下载
            </Button>
          </div>
        ))}
      </ManagementDialog>
    </section>
  )
}
