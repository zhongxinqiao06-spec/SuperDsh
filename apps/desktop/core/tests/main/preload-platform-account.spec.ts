import { expect, it, vi } from 'vitest'
const electron = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(async () => {}),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))
vi.mock('electron', () => electron)
import { createPlatformBridge } from '../../src/preload/preload-platform-account.ts'
import { IPC } from '../../src/main/ipc.ts'

it('uses the native main login action and carries the frozen target identity across the preload boundary', async () => {
  const bridge = createPlatformBridge()
  const input = {
    origin: 'https://test.invalid',
    identifier: 'alice',
    password: 'test-only',
  }
  const identity = { key: 'a'.repeat(64), generation: 7 }
  await bridge.loginWithPassword(input)
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
    IPC.platformAccount,
    'login-with-password',
    input,
  )
  await bridge.watch('session', 'owner', identity)
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
    IPC.platformWatch,
    { action: 'watch', sessionId: 'session', ownerId: 'owner', identity },
  )
  await bridge.upload('session', [], identity)
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
    IPC.platformUpload,
    'session',
    [],
    identity,
  )
})
