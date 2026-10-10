import { expect, it } from 'vitest'
import type {
  PlatformAccountState,
  PlatformJson,
} from '@superdsh/core/client/platform'
import {
  deviceDetail,
  localConnectionPresentation,
  ownedDeviceDirectory,
  platformLoginPresentation,
  shortDeviceId,
} from '../src/features/platform/device-directory.ts'

const connector = (id: string, extra: Record<string, PlatformJson> = {}) => ({
  id,
  userId: 'current-user',
  name: 'qzx',
  status: 'offline',
  deviceOs: 'windows',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra,
})
const account = (
  extra: Partial<PlatformAccountState> = {},
): PlatformAccountState => ({
  space: 'local',
  origin: 'http://platform.invalid',
  user: {
    userId: 'current-user',
    username: 'admin',
    email: null,
    displayName: 'admin',
    roles: ['admin'],
    permissions: [],
    authzVersion: 1,
    resetRequired: false,
  },
  status: 'ready',
  connectorId: 'this-device',
  connectorRunning: true,
  connectorPhase: 'ready',
  error: null,
  localImportAvailable: false,
  ...extra,
})

it('deduplicates only exact device IDs and retains distinct devices with the same name', () => {
  const directory = ownedDeviceDirectory(
    [
      connector('same-id'),
      connector('same-id', {
        status: 'online',
        updatedAt: '2026-10-02T00:00:00Z',
      }),
      connector('another-id'),
      connector('foreign-id', { userId: 'other-user' }),
      connector(''),
    ],
    'current-user',
  )
  expect(directory.map((row) => row.id)).toEqual(['same-id', 'another-id'])
  expect(directory[0]?.status).toBe('online')
  expect(directory.map((row) => row.name)).toEqual(['qzx', 'qzx'])
  expect(ownedDeviceDirectory([connector('same-id')], null)).toEqual([])
})

it('keeps the newer offline presence and gives a simultaneous blocked record precedence', () => {
  const directory = ownedDeviceDirectory(
    [
      connector('same-id', { status: 'online' }),
      connector('same-id', { updatedAt: '2026-10-03T00:00:00Z' }),
      connector('same-id', {
        status: 'online',
        blockedAt: '2026-10-03T00:00:00Z',
        updatedAt: '2026-10-03T00:00:00Z',
      }),
    ],
    'current-user',
  )
  expect(directory[0]?.blockedAt).toBe('2026-10-03T00:00:00Z')
})

it('chooses an unambiguous short ID and displays connection metadata instead of identifying by name', () => {
  const directory = ownedDeviceDirectory(
    [
      connector('old-device-111', { lastSeenAt: '2026-10-02T10:00:00Z' }),
      connector('old-device-222'),
    ],
    'current-user',
  )
  expect(shortDeviceId('old-device-111', directory)).not.toBe(
    shortDeviceId('old-device-222', directory),
  )
  const first = directory[0]
  if (!first) throw new Error('missing fixture device')
  expect(deviceDetail(first, directory)).toContain('Windows')
  expect(deviceDetail(first, directory)).toContain('最近连接')
  expect(deviceDetail(first, directory)).toContain('离线')
})

it('separates successful account login from an unsatisfied local connection', () => {
  const current = account({ connectorPhase: 'error', connectorRunning: false })
  expect(platformLoginPresentation(current)).toEqual({
    label: '平台账号：已登录',
    state: 'done',
  })
  expect(localConnectionPresentation(current, [], true)).toEqual({
    label: '本机：连接失败，本地聊天可用',
    state: 'error',
  })
  expect(
    localConnectionPresentation(
      account({ connectorPhase: 'syncing' }),
      [],
      true,
    ).state,
  ).toBe('ongoing')
})

it('requires exact current-device live presence rather than process existence or the hostname', () => {
  const sameName = ownedDeviceDirectory(
    [connector('another-id', { status: 'online' })],
    'current-user',
  )
  expect(localConnectionPresentation(account(), sameName, true).state).toBe(
    'warning',
  )
  const actual = ownedDeviceDirectory(
    [connector('this-device', { status: 'online' })],
    'current-user',
  )
  expect(localConnectionPresentation(account(), actual, true)).toEqual({
    label: '本机：已在线，可远程访问',
    state: 'done',
  })
  expect(
    localConnectionPresentation(
      account({ connectorRunning: false }),
      actual,
      true,
    ).state,
  ).toBe('idle')
  expect(
    localConnectionPresentation(
      account({ connectorOnline: false }),
      actual,
      true,
    ).state,
  ).toBe('warning')
  expect(
    localConnectionPresentation(
      account({ connectorPhase: 'reconnecting' }),
      actual,
      true,
    ),
  ).toEqual({
    label: '本机：连接中断，正在重连',
    state: 'ongoing',
  })
  expect(
    localConnectionPresentation(account({ status: 'offline' }), actual, true)
      .state,
  ).toBe('warning')
  expect(
    localConnectionPresentation(account(), actual, true, 'refresh failed')
      .state,
  ).toBe('warning')
})

it('keeps local usability visible while signed out or while a blocked device cannot connect', () => {
  expect(localConnectionPresentation(null, [], false)).toEqual({
    label: '本机：本地聊天可用',
    state: 'idle',
  })
  const blocked = ownedDeviceDirectory(
    [
      connector('this-device', {
        status: 'online',
        blockedAt: '2026-10-02T10:00:00Z',
      }),
    ],
    'current-user',
  )
  expect(localConnectionPresentation(account(), blocked, true)).toEqual({
    label: '本机：平台连接已停用，本地聊天可用',
    state: 'warning',
  })
})

it('preserves the real server execution source while legacy records remain desktop devices', () => {
  const directory = ownedDeviceDirectory(
    [
      connector('personal-server', {
        executorKind: 'server-agent',
        name: 'backend-owned-label',
        status: 'online',
      }),
      connector('legacy-desktop'),
      connector('foreign-server', {
        executorKind: 'server-agent',
        userId: 'other-user',
      }),
    ],
    'current-user',
  )
  expect(directory.map((device) => [device.id, device.executorKind])).toEqual([
    ['personal-server', 'server-agent'],
    ['legacy-desktop', 'desktop'],
  ])
  expect(directory[0]?.name).toBe('服务端 Agent')
})
