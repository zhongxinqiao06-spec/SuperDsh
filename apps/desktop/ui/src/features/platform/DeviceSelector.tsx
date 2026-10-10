import { useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'
import { PlatformSelect } from './PlatformSelect.tsx'
import {
  deviceDetail,
  localConnectionPresentation,
  platformLoginPresentation,
  shortDeviceId,
} from './device-directory.ts'

export function DeviceSelector({ model }: { model: PlatformWorkspaceModel }) {
  const {
    account,
    device,
    devices,
    devicesLoaded,
    deviceError,
    setDevice,
    setOpen,
    bridge,
    busy,
    run,
  } = model
  const [showOffline, setShowOffline] = useState(false)
  useEffect(() => setShowOffline(false), [account?.identityGeneration])
  const remote = devices.filter((row) => row.id !== account?.connectorId)
  const online = remote.filter(
    (row) => row.status === 'online' && !row.blockedAt,
  )
  const offline = remote.filter(
    (row) => row.status !== 'online' || !!row.blockedAt,
  )
  const visible = [
    ...online,
    ...offline.filter((row) => showOffline || row.id === device),
  ]
  const local = localConnectionPresentation(
    account,
    devices,
    devicesLoaded,
    deviceError,
  )
  const login = platformLoginPresentation(account)
  const options = [
    {
      value: '',
      label: '本机 · 此电脑',
      detail: local.label,
      group: '当前电脑',
    },
    ...visible.map((row) => ({
      value: row.id,
      label:
        remote.filter((other) => other.name === row.name).length > 1
          ? `${row.name} · ${shortDeviceId(row.id, remote)}`
          : row.name,
      detail: deviceDetail(row, remote),
      group: row.blockedAt
        ? '已停用设备'
        : row.status === 'online'
          ? '在线设备'
          : '离线设备',
    })),
  ]
  const currentDevice = devices.find((row) => row.id === account?.connectorId)
  const diagnostic = account?.error || deviceError
  const canRetry =
    account?.user &&
    !account.user.resetRequired &&
    !currentDevice?.blockedAt &&
    (local.state === 'error' ||
      local.state === 'warning' ||
      account.connectorPhase === 'stopped')
  return (
    <div
      className="productDeviceSelector"
      data-superdsh-source-selector
      data-selected-device={device}
    >
      <div className="productDeviceControls">
        <span className="productDeviceLabel">设备</span>
        <PlatformSelect
          label="当前聊天设备"
          value={device}
          options={options}
          className="productDevicePicker"
          triggerClassName="productDeviceTrigger"
          onChange={(next) => {
            setDevice(next)
            window.dispatchEvent(new Event('superdsh:conversation-target'))
          }}
        />
        <Button
          className="productPlatformAccountButton"
          size="sm"
          variant="outline"
          title={account?.user?.username || '登录平台'}
          onClick={() => setOpen(true)}
        >
          {account?.user?.username || '登录平台'}
        </Button>
      </div>
      <div className="productDeviceStatusRow" role="status">
        <StateDot state={login.state} />
        <span>{login.label}</span>
      </div>
      {account?.status === 'ready' && !account.user?.resetRequired && (
        <div className="productDeviceStatusRow">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || model.serverAgent.status === 'starting'}
            onClick={() => void run(model.prepareServerAgent)}
          >
            {model.serverAgent.status === 'starting'
              ? '服务端 Agent：准备中…'
              : '使用服务端 Agent'}
          </Button>
        </div>
      )}
      {(model.serverAgent.error || model.serverAgentError) && (
        <p className="platformError" role="status">
          {String(model.serverAgent.error || model.serverAgentError)}
        </p>
      )}
      <div className="productDeviceStatusRow" role="status">
        <StateDot state={local.state} />
        <span>{local.label}</span>
        {canRetry && bridge && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void run(() => bridge.connectDevice())
            }}
          >
            重试连接
          </Button>
        )}
      </div>
      {offline.length > 0 && (
        <Button
          className="productDeviceOfflineToggle"
          size="sm"
          variant="ghost"
          aria-expanded={showOffline}
          onClick={() => setShowOffline((current) => !current)}
        >
          {showOffline ? '收起离线设备' : `查看离线设备（${offline.length}）`}
        </Button>
      )}
      {diagnostic && (
        <div className="productConnectionDiagnostic" role="status">
          <span>{diagnostic}</span>
        </div>
      )}
    </div>
  )
}
