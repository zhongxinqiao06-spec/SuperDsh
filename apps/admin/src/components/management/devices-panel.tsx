'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
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

export function DevicesPanel() {
  const tr = useManagementText()
  const { can } = useAuth()
  const resource = useManagementResource('devices', managementApi.devices)
  const [search, setSearch] = React.useState('')
  const [reason, setReason] = React.useState('')
  const devices =
    resource.data?.devices.filter((device) =>
      `${device.name} ${device.username} ${device.userId} ${device.deviceOs}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? []
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {tr(
          '这里仅展示平台运维信息。会话、文件与终端仍只对设备所属用户开放。阻断设备会断开平台连接，恢复后允许重新连接。',
          'This inventory contains operational metadata. Sessions, files and terminals remain private to the device owner. Blocking disconnects the platform connection; resuming allows reconnection.',
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-sm"
          aria-label={tr('搜索设备', 'Search devices')}
          placeholder={tr('搜索设备或用户', 'Search devices or users')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {can('devices.connection.manage') && (
          <Input
            className="max-w-sm"
            aria-label={tr('阻断原因', 'Block reason')}
            placeholder={tr('阻断原因（可选）', 'Block reason (optional)')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        <Button variant="outline" onClick={resource.reload}>
          {tr('刷新', 'Refresh')}
        </Button>
      </div>
      <ResourceState {...resource} onRetry={resource.reload} />
      <div className="overflow-x-auto rounded-xl border">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('设备', 'Device')}</th>
              <th>{tr('所属用户', 'Owner')}</th>
              <th>{tr('运行信息', 'Runtime')}</th>
              <th>{tr('连接状态', 'Connection')}</th>
              <th>{tr('最近在线', 'Last seen')}</th>
              <th>{tr('运维操作', 'Operations')}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.id}>
                <td>
                  <div className="font-medium">{device.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {device.id}
                  </div>
                </td>
                <td>{device.username || device.userId}</td>
                <td>
                  {device.deviceOs || '—'}
                  <div className="text-xs text-muted-foreground">
                    {device.connectorKind} · {device.version || '—'}
                  </div>
                </td>
                <td>
                  {device.blockedAt ? tr('已阻断', 'Blocked') : device.status}
                  {device.blockedReason && (
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {device.blockedReason}
                    </p>
                  )}
                </td>
                <td>{dateLabel(device.lastSeenAt)}</td>
                <td>
                  {can('devices.connection.manage') && (
                    <Button
                      size="sm"
                      variant={device.blockedAt ? 'outline' : 'destructive'}
                      disabled={resource.busy}
                      onClick={() =>
                        void resource.perform(() =>
                          device.blockedAt
                            ? managementApi.resumeDevice(device.id)
                            : managementApi.blockDevice(device.id, reason),
                        )
                      }
                    >
                      {device.blockedAt
                        ? tr('恢复连接', 'Resume')
                        : tr('阻断连接', 'Block')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.loading && devices.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">
            {tr('没有匹配的设备。', 'No matching devices.')}
          </p>
        )}
      </div>
    </div>
  )
}
