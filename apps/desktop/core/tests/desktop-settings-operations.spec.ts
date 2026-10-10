import { describe, expect, it, vi } from 'vitest'
import type { DesktopSettingsView } from '../src/client/desktop-settings-api.ts'
import {
  changeDesktopProfile,
  persistDesktopBrowserAccessHot,
  readDesktopSettingsUntilLanSettled,
} from '../src/client/desktop-settings-operations.ts'

const view = (
  lanState: DesktopSettingsView['web']['lanState'],
): DesktopSettingsView => ({
  current: 'desktop',
  profiles: [],
  market: {
    requested: 'disabled',
    effective: 'disabled',
    legacyDefaulted: false,
  },
  web: {
    localUrl: '',
    lanUrls: [],
    lanState,
    lanError: null,
    lanCaFingerprint: null,
    lanCaUrls: [],
  },
})

describe('desktop settings operations', () => {
  it('follows a LAN transition but never publishes an aborted response', async () => {
    const starting = view('starting'),
      ready = view('ready')
    const read = vi
      .fn()
      .mockResolvedValueOnce(starting)
      .mockResolvedValueOnce(ready)
    const publish = vi.fn(),
      wait = vi.fn(async () => {})
    expect(
      await readDesktopSettingsUntilLanSettled(
        { read },
        publish,
        new AbortController().signal,
        wait,
      ),
    ).toBe(ready)
    expect(publish.mock.calls.map(([value]) => value.web.lanState)).toEqual([
      'starting',
      'ready',
    ])
    expect(wait).toHaveBeenCalledOnce()
    const controller = new AbortController()
    const abortedPublish = vi.fn()
    await expect(
      readDesktopSettingsUntilLanSettled(
        {
          read: async () => {
            controller.abort()
            return ready
          },
        },
        abortedPublish,
        controller.signal,
        wait,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(abortedPublish).not.toHaveBeenCalled()
  })

  it('turns LAN off before disabling browser access, then refreshes once', async () => {
    const calls: string[] = [],
      ready = view('inactive')
    const result = await persistDesktopBrowserAccessHot(
      {
        set: async (field, value) => {
          calls.push(`${field}:${String(value)}`)
          return true
        },
      },
      false,
      'lan',
      async () => {
        calls.push('refresh')
        return ready
      },
    )
    expect(result).toBe(ready)
    expect(calls).toEqual([
      'networkExposure:loopback',
      'openBrowser:false',
      'refresh',
    ])
  })

  it('normalizes new profiles and does not refresh a profile generation that is restarting', async () => {
    const current = view('inactive')
    const api = {
      read: vi.fn(async () => current),
      createProfile: vi.fn(async () => current),
      deleteProfile: vi.fn(async () => current),
      selectProfile: vi.fn(async () => ({
        accepted: true as const,
        restartRequired: true,
      })),
    }
    expect(
      await changeDesktopProfile(api, { kind: 'create', name: '   ' }),
    ).toEqual({ status: 'unchanged' })
    expect(api.createProfile).not.toHaveBeenCalled()
    expect(
      await changeDesktopProfile(api, { kind: 'create', name: '  work  ' }),
    ).toEqual({ status: 'updated', view: current })
    expect(api.createProfile).toHaveBeenCalledWith('work')
    expect(
      await changeDesktopProfile(api, { kind: 'select', name: 'work' }),
    ).toEqual({ status: 'restart-required' })
    expect(api.read).not.toHaveBeenCalled()
    api.selectProfile.mockResolvedValue({
      accepted: true,
      restartRequired: false,
    })
    expect(
      await changeDesktopProfile(api, { kind: 'select', name: 'desktop' }),
    ).toEqual({ status: 'updated', view: current })
    expect(api.read).toHaveBeenCalledOnce()
  })
})
