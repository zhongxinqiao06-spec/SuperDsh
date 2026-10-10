'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { managementApi } from '@/features/management/api'
import {
  dateLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'

export function AuditPanel() {
  const tr = useManagementText()
  const resource = useManagementResource('audit', managementApi.audit)
  const [search, setSearch] = React.useState('')
  const events =
    resource.data?.events.filter((event) =>
      `${event.actorId} ${event.action} ${event.targetId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
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
        <Button variant="outline" onClick={resource.reload}>
          {tr('刷新', 'Refresh')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {tr(
          '显示最近的管理操作记录，不包含聊天内容或密钥。',
          'Recent administrative operations, without conversation content or credentials.',
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
                  <pre className="max-w-sm whitespace-pre-wrap break-words text-xs">
                    {event.detail ? JSON.stringify(event.detail, null, 2) : '—'}
                  </pre>
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
    </div>
  )
}
