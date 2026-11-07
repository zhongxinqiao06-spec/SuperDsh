'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import type {
  AgentResource,
  ResourcePage,
} from '@/features/agents/resources-api'
import {
  dateLabel,
  ResourceState,
  useManagementResource,
  useManagementText,
} from './controls'
import { ManagementDialog, ManagementPagination } from './presentation'

export function AgentResourceHistory({
  item,
  api,
  onClose,
  onRestored,
}: {
  item: AgentResource
  api: {
    versions: (
      id: string,
      page: number,
      pageSize: number,
    ) => Promise<ResourcePage<AgentResource> & { currentVersion: number }>
    restore: (
      id: string,
      sourceVersion: number,
      version: number,
    ) => Promise<unknown>
  }
  onClose: () => void
  onRestored: () => void
}) {
  const tr = useManagementText()
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [selected, setSelected] = React.useState<AgentResource | null>(null)
  const history = useManagementResource(`${item.id}:${page}:${pageSize}`, () =>
    api.versions(item.id, page, pageSize),
  )
  return (
    <ManagementDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={tr(`${item.name} · 版本记录`, `${item.name} · Versions`)}
      description={tr(
        '恢复将创建新版本并重新校验依赖和凭据。已有会话继续使用冻结的版本；停用仍即时生效。',
        'Restoring creates a new validated version. Existing sessions retain their snapshot; disabling still applies immediately.',
      )}
      error={history.error}
    >
      <ResourceState
        loading={history.loading}
        error=""
        onRetry={history.reload}
      />
      <div className="space-y-3">
        {history.data?.items.map((version) => (
          <div key={version.version} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <span>
                v{version.version} · {dateLabel(version.updatedAt)}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelected(version)}
              >
                {tr('查看配置', 'Inspect')}
              </Button>
            </div>
            {selected?.version === version.version && (
              <>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                  {JSON.stringify(version, null, 2)}
                </pre>
                <Button
                  className="mt-2"
                  disabled={
                    history.busy ||
                    version.version === history.data?.currentVersion
                  }
                  onClick={async () => {
                    if (
                      await history.perform(() =>
                        api.restore(
                          item.id,
                          version.version,
                          history.data!.currentVersion,
                        ),
                      )
                    ) {
                      setSelected(null)
                      onRestored()
                    }
                  }}
                >
                  {tr('恢复为新版本', 'Restore as new version')}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      <ManagementPagination
        page={page}
        pageSize={pageSize}
        total={history.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        loading={history.loading || history.busy}
      />
    </ManagementDialog>
  )
}
