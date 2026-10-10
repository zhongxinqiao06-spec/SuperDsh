import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { installMediaPermissions } from '../../src/main/electron-permissions.ts'
import type { NativePermissions } from '../../src/main/native-permissions.ts'

const fixture = vi.hoisted(() => ({
  sources: vi.fn(),
  select: 1,
  menu: [] as any[],
}))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: fixture.sources },
  shell: {},
  systemPreferences: {},
  Menu: {
    buildFromTemplate: (items: any[]) => {
      fixture.menu = items
      return {
        popup: ({ callback }: any) => {
          if (fixture.select >= 0) items[fixture.select].click()
          callback()
        },
        closePopup() {},
      }
    },
  },
}))
beforeEach(() => {
  fixture.sources.mockReset().mockResolvedValue([
    { id: 'screen:1', name: 'Screen 1' },
    { id: 'screen:2', name: 'Screen 2' },
  ])
  fixture.select = 1
})

function setup() {
  let check!: Parameters<Session['setPermissionCheckHandler']>[0]
  let request!: Parameters<Session['setPermissionRequestHandler']>[0]
  let display!: Parameters<Session['setDisplayMediaRequestHandler']>[0]
  let picker: unknown
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: {
      getURL: () => 'dsh-app://app/',
      isDestroyed: () => false,
      isFocused: () => true,
      mainFrame: {},
      executeJavaScript: vi.fn(async () => true),
    },
  }) as unknown as BrowserWindow
  const extension = {
    getURL: () => 'dsh-app://compat/compatibility.html',
    isDestroyed: () => false,
    isFocused: () => true,
    mainFrame: {},
    executeJavaScript: vi.fn(async () => true),
  } as unknown as WebContents
  let currentExtension: WebContents | undefined = extension
  const permission = {
    query: vi.fn(() => ({ status: 'not-determined' })),
    request: vi.fn(async () => ({ status: 'granted' })),
  }
  installMediaPermissions(
    {
      setPermissionCheckHandler: (handler) => {
        check = handler
      },
      setPermissionRequestHandler: (handler) => {
        request = handler
      },
      setDisplayMediaRequestHandler: (handler, options) => {
        display = handler
        picker = options
      },
    } as Session,
    permission as unknown as NativePermissions,
    {
      window: () => owner,
      extension: () => currentExtension,
      language: () => 'en',
      warn: vi.fn(),
    },
  )
  return {
    check: check!,
    request: request!,
    display: display!,
    owner,
    permission,
    picker,
    extension,
    revoke: () => {
      currentExtension = undefined
    },
  }
}

it('keeps passive checks prompt-free and denies foreign frames and camera access', async () => {
  const { check, request, owner, permission } = setup()
  expect(
    check(owner.webContents, 'media', 'dsh-app://app', {
      isMainFrame: true,
      mediaType: 'audio',
    }),
  ).toBe(false)
  expect(permission.request).not.toHaveBeenCalled()
  const callback = vi.fn()
  request(owner.webContents, 'media', callback, {
    requestingUrl: 'https://example.com',
    isMainFrame: true,
    mediaTypes: ['audio'],
  })
  request(owner.webContents, 'media', callback, {
    requestingUrl: 'dsh-app://app/',
    isMainFrame: false,
    mediaTypes: ['audio'],
  })
  request(owner.webContents, 'media', callback, {
    requestingUrl: 'dsh-app://app/',
    isMainFrame: true,
    mediaTypes: ['video'],
  })
  expect(callback.mock.calls).toEqual([[false], [false], [false]])
  expect(permission.request).not.toHaveBeenCalled()
  request(owner.webContents, 'media', callback, {
    requestingUrl: 'dsh-app://app/',
    isMainFrame: true,
    mediaTypes: ['audio'],
  })
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith(true))
  expect(permission.request).toHaveBeenCalledWith('microphone')
})

it('admits only the current compatibility main frame for microphone consent', async () => {
  const { check, request, extension, permission, revoke } = setup()
  permission.query.mockReturnValue({ status: 'granted' })
  expect(
    check(extension, 'media', 'dsh-app://compat', {
      isMainFrame: true,
      mediaType: 'audio',
    }),
  ).toBe(true)
  expect(
    check(extension, 'media', 'dsh-app://app', {
      isMainFrame: true,
      mediaType: 'audio',
    }),
  ).toBe(false)
  expect(
    check(extension, 'media', 'dsh-app://compat', {
      isMainFrame: false,
      mediaType: 'audio',
    }),
  ).toBe(false)
  const callback = vi.fn()
  const details = {
    requestingUrl: 'dsh-app://compat/compatibility.html',
    isMainFrame: true,
    mediaTypes: ['audio'] as ('audio' | 'video')[],
  }
  request({ ...extension } as WebContents, 'media', callback, details)
  expect(callback).toHaveBeenLastCalledWith(false)
  request(extension, 'media', callback, details)
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith(true))
  expect(permission.request).toHaveBeenCalledExactlyOnceWith('microphone')
  vi.mocked(extension.executeJavaScript).mockResolvedValue(false)
  request(extension, 'media', callback, details)
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith(false))
  expect(permission.request).toHaveBeenCalledTimes(1)
  revoke()
  expect(
    check(extension, 'media', 'dsh-app://compat', {
      isMainFrame: true,
      mediaType: 'audio',
    }),
  ).toBe(false)
})

it('does not grant delayed microphone consent to a retired compatibility renderer', async () => {
  const { request, extension, permission, revoke } = setup()
  const consent = Promise.withResolvers<{ status: string }>()
  permission.request.mockImplementationOnce(() => consent.promise)
  const callback = vi.fn()
  request(extension, 'media', callback, {
    requestingUrl: 'dsh-app://compat/compatibility.html',
    isMainFrame: true,
    mediaTypes: ['audio'],
  })
  await vi.waitFor(() => expect(permission.request).toHaveBeenCalled())
  revoke()
  consent.resolve({ status: 'granted' })
  await vi.waitFor(() =>
    expect(callback).toHaveBeenCalledExactlyOnceWith(false),
  )
})

it('allows the owned compatibility screen picker and rejects revoked or foreign frames', async () => {
  const { display, extension, revoke } = setup()
  const request = {
    frame: extension.mainFrame,
    securityOrigin: 'dsh-app://compat',
    videoRequested: true,
    audioRequested: false,
    userGesture: true,
  }
  const callback = vi.fn()
  display({ ...request, securityOrigin: 'dsh-app://app' }, callback)
  display({ ...request, frame: {} as Electron.WebFrameMain }, callback)
  expect(fixture.sources).not.toHaveBeenCalled()
  display(request, callback)
  await vi.waitFor(() =>
    expect(callback).toHaveBeenLastCalledWith({
      video: { id: 'screen:1', name: 'Screen 1' },
    }),
  )
  const sources = Promise.withResolvers<{ id: string; name: string }[]>()
  fixture.sources.mockImplementationOnce(() => sources.promise)
  display(request, callback)
  revoke()
  sources.resolve([{ id: 'screen:1', name: 'Screen 1' }])
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith({}))
})

it('requires a gesture for a new microphone request', async () => {
  const { request, owner, permission } = setup()
  vi.mocked(owner.webContents.executeJavaScript).mockResolvedValue(false)
  const callback = vi.fn()
  request(owner.webContents, 'media', callback, {
    requestingUrl: 'dsh-app://app/',
    isMainFrame: true,
    mediaTypes: ['audio'],
  })
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
  expect(permission.request).not.toHaveBeenCalled()
})

it('settles consent callbacks once when the requesting frame has gone away', async () => {
  const { request, display, owner } = setup()
  const microphone = vi.fn(() => {
    throw new Error('Frame gone')
  })
  const screen = vi.fn(() => {
    throw new Error('Frame gone')
  })
  request(owner.webContents, 'media', microphone, {
    requestingUrl: 'dsh-app://app/',
    isMainFrame: true,
    mediaTypes: ['audio'],
  })
  display(
    {
      frame: owner.webContents.mainFrame,
      securityOrigin: 'dsh-app://app',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    },
    screen,
  )
  await vi.waitFor(() => {
    expect(microphone).toHaveBeenCalledOnce()
    expect(screen).toHaveBeenCalledOnce()
  })
})

it('uses the system picker or an explicit source selection and handles cancellation', async () => {
  const { display, owner, picker } = setup()
  expect(picker).toEqual({ useSystemPicker: true })
  const callback = vi.fn()
  const request = {
    frame: owner.webContents.mainFrame,
    securityOrigin: 'dsh-app://app',
    videoRequested: true,
    audioRequested: false,
    userGesture: true,
  }
  fixture.select = 2
  display(request, callback)
  await vi.waitFor(() =>
    expect(callback).toHaveBeenCalledWith({
      video: { id: 'screen:2', name: 'Screen 2' },
    }),
  )
  expect(fixture.sources).toHaveBeenCalledWith({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  })
  fixture.select = -1
  display(request, callback)
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith({}))
  fixture.sources.mockClear()
  display({ ...request, userGesture: false }, callback)
  display({ ...request, frame: {} as Electron.WebFrameMain }, callback)
  expect(fixture.sources).not.toHaveBeenCalled()
})
