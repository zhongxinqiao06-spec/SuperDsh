'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { managementApi, type AuditEvent } from '@/features/management/api'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
} from './presentation'
import {
  dateLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'

export function AuditPanel() {
  const tr = useManagementText()
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [selected, setSelected] = React.useState<AuditEvent | null>(null)
  const resource = useManagementResource(
    `audit:${page}:${pageSize}:${filter}`,
    () => managementApi.audit(page, filter, pageSize),
  )
  const events = resource.data?.events ?? []
  const total = resource.data?.total ?? events.length
  React.useEffect(() => {
    if (resource.data && page > Math.max(1, Math.ceil(total / pageSize)))
      setPage(Math.max(1, Math.ceil(total / pageSize)))
  }, [resource.data, page, pageSize, total])
  return (
    <ManagementList
      pagination={
        <ManagementPagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
          loading={resource.loading}
        />
      }
    >
      <form
        className="flex flex-wrap items-center gap-2 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault()
          setFilter(search.trim())
          setPage(1)
        }}
      >
        <Input
          className="max-w-sm"
          aria-label={tr('筛选审计日志', 'Filter audit events')}
          placeholder={tr(
            '按操作者、操作或目标筛选',
            'Filter actor, action or target',
          )}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={resource.loading}
        >
          {tr('搜索', 'Search')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={resource.reload}
          disabled={resource.loading}
        >
          {tr('刷新', 'Refresh')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {tr(
          '分页查询管理操作记录，不包含聊天内容或密钥。',
          'Browse administrative operations, without conversation content or credentials.',
        )}
      </p>
      <ResourceState {...resource} onRetry={resource.reload} />
      <div className="overflow-x-auto rounded-xl border">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('时间', 'Time')}</th>
              <th>{tr('操作者', 'Actor')}</th>
              <th>{tr('操作', 'Action')}</th>
              <th>{tr('目标', 'Target')}</th>
              <th>{tr('详情', 'Details')}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap">
                  {dateLabel(event.createdAt)}
                </td>
                <td>{event.actorId || '—'}</td>
                <td>{event.action}</td>
                <td>{event.targetId || '—'}</td>
                <td>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelected(event)}
                  >
                    {tr('查看详情', 'View details')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.loading && events.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">
            {tr('暂无匹配记录。', 'No matching events.')}
          </p>
        )}
      </div>

      <ManagementDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={tr('审计详情', 'Audit details')}
        description={selected ? dateLabel(selected.createdAt) : undefined}
        footer={
          <Button variant="outline" onClick={() => setSelected(null)}>
            {tr('关闭', 'Close')}
          </Button>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-3 text-sm">
          <dt>{tr('操作者', 'Actor')}</dt>
          <dd className="break-all">{selected?.actorId || '—'}</dd>
          <dt>{tr('操作', 'Action')}</dt>
          <dd>{selected?.action}</dd>
          <dt>{tr('目标', 'Target')}</dt>
          <dd className="break-all">{selected?.targetId || '—'}</dd>
        </dl>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs">
          {selected?.detail ? JSON.stringify(selected.detail, null, 2) : '—'}
        </pre>
      </ManagementDialog>
    </ManagementList>
  )
}
