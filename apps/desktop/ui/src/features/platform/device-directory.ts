import type {
  PlatformAccountState,
  PlatformJson,
} from '@superdsh/core/client/platform'
import { rows, string } from './platform-model.ts'

export interface PlatformDevice {
  executorKind: 'desktop' | 'server-agent'
  id: string
  userId: string
  name: string
  connectorKind: string
  deviceOs: string | null
  status: 'online' | 'offline'
  lastSeenAt: string | null
  createdAt: string | null
  updatedAt: string | null
  blockedAt: string | null
  blockedReason: string | null
  version: string | null
}

/** A name describes a device; only its server ID identifies it. */
export function ownedDeviceDirectory(
  value: PlatformJson | undefined,
  userId: string | null | undefined,
): PlatformDevice[] {
  if (!userId) return []
  const directory = new Map<string, PlatformDevice>()
  for (const row of rows(value)) {
    const id = string(row.id)
    if (!id || row.userId !== userId) continue
    const device: PlatformDevice = {
      executorKind:
        row.executorKind === 'server-agent' ? 'server-agent' : 'desktop',
      id,
      userId,
      name:
        row.executorKind === 'server-agent'
          ? '服务端 Agent'
          : string(row.name).trim() || '未命名设备',
      connectorKind: string(row.connectorKind),
      deviceOs: string(row.deviceOs) || null,
      status: row.status === 'online' ? 'online' : 'offline',
      lastSeenAt: string(row.lastSeenAt) || null,
      createdAt: string(row.createdAt) || null,
      updatedAt: string(row.updatedAt) || null,
      blockedAt: string(row.blockedAt) || null,
      blockedReason: string(row.blockedReason) || null,
      version: string(row.version) || null,
    }
    const previous = directory.get(id)
    if (!previous || newerDevice(device, previous)) directory.set(id, device)
  }
  return [...directory.values()]
}

function changedAt(device: PlatformDevice): number {
  return (
    Date.parse(
      device.updatedAt || device.lastSeenAt || device.createdAt || '',
    ) || 0
  )
}

function newerDevice(next: PlatformDevice, previous: PlatformDevice): boolean {
  const difference = changedAt(next) - changedAt(previous)
  if (difference) return difference > 0
  if (next.blockedAt !== previous.blockedAt) return !!next.blockedAt
  return next.status === 'online' && previous.status !== 'online'
}

export function deviceStatusLabel(device: PlatformDevice): string {
  return device.blockedAt
    ? '已停用'
    : device.status === 'online'
      ? '在线'
      : '离线'
}

export function shortDeviceId(
  id: string,
  devices: readonly PlatformDevice[],
): string {
  for (let length = 8; length < id.length; length += 2) {
    const prefix = id.slice(0, length)
    if (devices.every((row) => row.id === id || !row.id.startsWith(prefix)))
      return prefix
  }
  return id
}

export function deviceDetail(
  device: PlatformDevice,
  devices: readonly PlatformDevice[],
): string {
  const operatingSystems: Record<string, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
  }
  const operatingSystem = operatingSystems[device.deviceOs || '']
  const seen =
    device.lastSeenAt && Number.isFinite(Date.parse(device.lastSeenAt))
      ? new Date(device.lastSeenAt).toLocaleDateString('zh-CN')
      : null
  return [
    deviceStatusLabel(device),
    operatingSystem,
    shortDeviceId(device.id, devices),
    seen ? `最近连接 ${seen}` : '尚无连接记录',
  ]
    .filter(Boolean)
    .join(' · ')
}

export interface DeviceStatusPresentation {
  label: string
  state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
}

export function platformLoginPresentation(
  account: PlatformAccountState | null,
): DeviceStatusPresentation {
  if (account?.status === 'authenticating' || account?.status === 'authorizing')
    return { label: '平台账号：正在登录', state: 'ongoing' }
  if (account?.status === 'switching')
    return { label: '平台账号：正在切换', state: 'ongoing' }
  if (!account?.user) return { label: '平台账号：未登录', state: 'idle' }
  if (account.user.resetRequired)
    return { label: '平台账号：需修改临时密码', state: 'warning' }
  if (account.status === 'offline')
    return { label: '平台账号：已登录，服务暂不可达', state: 'warning' }
  return { label: '平台账号：已登录', state: 'done' }
}

export function localConnectionPresentation(
  account: PlatformAccountState | null,
  devices: readonly PlatformDevice[],
  loaded: boolean,
  directoryError: string | null = null,
): DeviceStatusPresentation {
  if (!account?.user) return { label: '本机：本地聊天可用', state: 'idle' }
  const current = devices.find((device) => device.id === account.connectorId)
  if (current?.blockedAt)
    return { label: '本机：平台连接已停用，本地聊天可用', state: 'warning' }
  if (account.connectorPhase === 'error')
    return { label: '本机：连接失败，本地聊天可用', state: 'error' }
  if (account.status === 'offline')
    return { label: '本机：平台暂不可达，本地聊天可用', state: 'warning' }
  const preparing = {
    'preparing-python': '准备 Python 3.12',
    'preparing-dependencies': '准备连接依赖',
    registering: '关联本机',
    starting: '连接管理平台',
    syncing: '准备并同步会话',
    reconnecting: '连接中断，正在重连',
  }
  const phase = account.connectorPhase
  if (phase && phase in preparing)
    return {
      label: `本机：${preparing[phase as keyof typeof preparing]}`,
      state: 'ongoing',
    }
  if (phase === 'ready' && account.connectorRunning) {
    if (directoryError)
      return {
        label: '本机：连接状态暂不可确认，本地聊天可用',
        state: 'warning',
      }
    if (current?.status === 'online' && account.connectorOnline !== false)
      return { label: '本机：已在线，可远程访问', state: 'done' }
    return loaded
      ? { label: '本机：尚未在线，本地聊天可用', state: 'warning' }
      : { label: '本机：确认连接状态', state: 'ongoing' }
  }
  return { label: '本机：未连接平台，本地聊天可用', state: 'idle' }
}
