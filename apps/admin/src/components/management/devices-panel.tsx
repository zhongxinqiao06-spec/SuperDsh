'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { managementApi, type DeviceInventory } from '@/features/management/api'
import { ManagementDialog, ManagementPagination } from './presentation'
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
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const resource = useManagementResource(
    `devices:${page}:${pageSize}:${filter}`,
    () => managementApi.devices(page, filter, pageSize),
  )
  const [reason, setReason] = React.useState('')
  const [selected, setSelected] = React.useState<DeviceInventory | null>(null)
  const devices = resource.data?.devices ?? []
  const total = resource.data?.total ?? devices.length
  React.useEffect(() => {
    if (resource.data && page > Math.max(1, Math.ceil(total / pageSize)))
      setPage(Math.max(1, Math.ceil(total / pageSize)))
  }, [resource.data, page, pageSize, total])
  const operate = async () => {
    if (!selected || !can('devices.connection.manage') || resource.busy) return
    const success = await resource.perform(() =>
      selected.blockedAt
        ? managementApi.resumeDevice(selected.id)
        : managementApi.blockDevice(selected.id, reason.trim()),
    )
    if (success) setSelected(null)
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {tr(
          '这里仅展示平台运维信息。会话、文件与终端仍只对设备所属用户开放。阻断设备会断开平台连接，恢复后允许重新连接。',
          'This inventory contains operational metadata. Sessions, files and terminals remain private to the device owner. Blocking disconnects the platform connection; resuming allows reconnection.',
        )}
      </p>
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
          aria-label={tr('搜索设备', 'Search devices')}
          placeholder={tr('搜索设备或用户', 'Search devices or users')}
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
                      onClick={() => {
                        setSelected(device)
                        setReason('')
                      }}
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
      <ManagementPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        loading={resource.loading || resource.busy}
      />
      <ManagementDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={
          selected?.blockedAt
            ? tr('恢复设备连接', 'Resume device connection')
            : tr('阻断设备连接', 'Block device connection')
        }
        description={
          selected?.blockedAt
            ? tr(
                '恢复后，此设备可重新连接平台。',
                'This device will be allowed to reconnect.',
              )
            : tr(
                '阻断会立即断开平台连接，并阻止自动重连；设备上的本地任务不会被终止。',
                'Blocking disconnects the platform connection and prevents reconnection. Local tasks on the device are not stopped.',
              )
        }
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy}
              onClick={() => setSelected(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant={selected?.blockedAt ? 'default' : 'destructive'}
              disabled={resource.busy || !can('devices.connection.manage')}
              onClick={() => void operate()}
            >
              {tr('确认', 'Confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm font-medium">
          {selected?.name} · {selected?.username || selected?.userId}
        </p>
        {!selected?.blockedAt && (
          <label className="space-y-2 text-sm">
            {tr('阻断原因（可选）', 'Block reason (optional)')}
            <Input
              aria-label={tr('阻断原因', 'Block reason')}
              value={reason}
              maxLength={500}
              disabled={resource.busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        )}
      </ManagementDialog>
    </div>
  )
}
