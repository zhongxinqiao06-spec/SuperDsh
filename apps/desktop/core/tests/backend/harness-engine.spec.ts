import { afterEach, expect, it, vi } from 'vitest'
import {
  HarnessEngineFacade,
  type HarnessEngineOptions,
} from '../../src/backend/harness-engine.ts'
import { DEFAULT_PREFERENCES } from '../../src/contracts/desktop-contract.ts'
import type { DesktopHostProcess } from '../../src/backend/host-process.ts'
import { authenticateWebHost } from '../../src/backend/web-auth.ts'

vi.mock('../../src/backend/web-auth.ts', () => ({
  authenticateWebHost: vi.fn(async () => 'session=fixture'),
}))
afterEach(() => {
  vi.clearAllMocks()
})

function fixture(ready: { url: string; injections?: readonly unknown[] }) {
  const start = vi.fn(async () => ready)
  const stop = vi.fn(async (_graceful?: boolean) => {})
  const process = { start, stop } as unknown as DesktopHostProcess
  const createProcess = vi.fn(() => process)
  const options: HarnessEngineOptions = {
    runtime: {
      root: '/product',
      home: '/fixture',
      executable: 'fixture-node',
      frontendManifest: '/fixture/client-manifest.json',
      addresses: () => [],
      certificate: async () => {
        throw new Error('not used')
      },
      onFailure() {},
      onChange() {},
      onRestart() {},
      onTerminal() {},
      onNotification() {},
    },
    home: '/fixture',
    profileDirectory: '/fixture/profiles/desktop',
    preferences: DEFAULT_PREFERENCES,
    addresses: [],
    safeMode: false,
    onFailure() {},
    onLog() {},
  }
  return {
    engine: new HarnessEngineFacade(options, createProcess),
    start,
    stop,
    createProcess,
  }
}

it.each([
  'https://127.0.0.1:1234/',
  'http://example.test/',
  'http://localhost:1234/',
])(
  'rejects an unexpected transport before exchanging credentials: %s',
  async (url) => {
    await expect(
      fixture({ url, injections: [] }).engine.start(),
    ).rejects.toThrow('loopback HTTP')
    expect(authenticateWebHost).not.toHaveBeenCalled()
  },
)

it('requires boot injections before granting the product an authenticated engine connection', async () => {
  await expect(
    fixture({ url: 'http://127.0.0.1:1234/' }).engine.start(),
  ).rejects.toThrow('boot injections')
  expect(authenticateWebHost).not.toHaveBeenCalled()
})

it('keeps launch credentials private and forwards explicit graceful shutdown', async () => {
  const { engine, stop } = fixture({
    url: 'http://127.0.0.1:1234/?token=fixture',
    injections: [{ type: 'fixture' }],
  })
  const connection = await engine.start()
  expect(connection.cookie).toBe('session=fixture')
  expect(connection.token.length).toBeGreaterThanOrEqual(40)
  expect(authenticateWebHost).toHaveBeenCalledWith(
    connection.url,
    connection.token,
  )
  expect(connection.injections).toEqual([{ type: 'fixture' }])
  await engine.stop(true)
  expect(stop).toHaveBeenCalledExactlyOnceWith(true)
})

it('propagates authentication failure instead of reporting the engine ready', async () => {
  vi.mocked(authenticateWebHost).mockRejectedValueOnce(
    new Error('Host rejected launch authority'),
  )
  await expect(
    fixture({ url: 'http://127.0.0.1:1234/', injections: [] }).engine.start(),
  ).rejects.toThrow('launch authority')
})
