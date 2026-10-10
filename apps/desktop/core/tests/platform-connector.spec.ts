import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  prepareConnectorPython,
  connectorPythonEnvironment,
} from '../src/main/platform-connector-python.ts'
import {
  ensureManagedDshRuntime,
  PlatformConnector,
} from '../src/main/platform-connector.ts'
import {
  readConnectorBinding,
  saveConnectorBinding,
} from '../src/main/platform-connector-binding.ts'
import { PlatformSpaces, accountSpaceKey } from '../src/main/platform-spaces.ts'
import type { PlatformAccount } from '../src/main/platform-account.ts'
import type { PlatformJson } from '../src/contracts/platform.ts'
const roots: string[] = []
const activeConnectors: PlatformConnector[] = []
afterEach(async () => {
  await Promise.all(activeConnectors.splice(0).map((value) => value.stop()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const testSecrets = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => {
    if (value.toString() === 'old-chromium-key')
      throw new Error('Test ciphertext uses another Chromium key')
    return value.toString()
  },
}
async function bindingFixture() {
  const directory = await root()
  const spaces = new PlatformSpaces(
    join(directory, 'default'),
    join(directory, 'local'),
  )
  const key = accountSpaceKey('https://a.example', 'alice')
  const scoped = join(spaces.directoryFor(key), 'connector')
  const json = vi.fn(
    async (
      _path: string,
      _method?: string,
      _body?: PlatformJson,
    ): Promise<PlatformJson> => null,
  )
  const account = {
    spaces,
    identityKey: key,
    origin: 'https://a.example',
    user: { userId: 'alice', resetRequired: false },
    token: async () => 'test-token',
    json,
  } as unknown as PlatformAccount
  return { directory, spaces, scoped, key, json, account }
}
const unreadable = JSON.stringify({
  encrypted: Buffer.from('old-chromium-key').toString('base64'),
})
it('preserves unreadable legacy ciphertext and persists one new installation identity', async () => {
  const f = await bindingFixture()
  const legacy = join(f.spaces.homeFor(f.key), 'platform-connector')
  await mkdir(legacy, { recursive: true })
  const file = join(legacy, 'binding.enc.json')
  await writeFile(file, unreadable)
  const diagnostic = vi.fn()
  const options = {
    account: f.account,
    secrets: testSecrets,
    key: f.key,
    directory: f.scoped,
    diagnostic,
  }
  const binding = await readConnectorBinding(options)
  expect(binding.installationId).toMatch(/^[a-f0-9-]{36}$/)
  expect(binding.connectorId).toBeUndefined()
  expect(f.json).not.toHaveBeenCalled()
  saveConnectorBinding(f.scoped, testSecrets, binding)
  expect(await readConnectorBinding(options)).toEqual(binding)
  expect(await readFile(file, 'utf8')).toBe(unreadable)
  expect(
    JSON.parse(await readFile(join(f.scoped, 'installation.json'), 'utf8')),
  ).toEqual({ installationId: binding.installationId })
  expect(diagnostic).toHaveBeenCalledOnce()
})
it('recovers only non-secret current binding metadata and keeps an encrypted backup', async () => {
  const f = await bindingFixture()
  await mkdir(f.scoped, { recursive: true })
  await writeFile(join(f.scoped, 'binding.enc.json'), unreadable)
  await writeFile(
    join(f.scoped, 'installation.json'),
    JSON.stringify({
      installationId: 'stable-installation',
      connectorId: 'mine',
    }),
  )
  const binding = await readConnectorBinding({
    account: f.account,
    secrets: testSecrets,
    key: f.key,
    directory: f.scoped,
  })
  expect(binding).toEqual({
    installationId: 'stable-installation',
    connectorId: 'mine',
  })
  const backup = (await readdir(f.scoped)).find((name) =>
    name.startsWith('binding.unreadable-'),
  )!
  expect(await readFile(join(f.scoped, backup), 'utf8')).toBe(unreadable)
  expect(await readFile(join(f.scoped, 'binding.enc.json'), 'utf8')).toBe(
    unreadable,
  )
})
it('repairs malformed installation metadata from valid encrypted credentials', async () => {
  const f = await bindingFixture()
  const original = {
    installationId: 'stable-installation',
    connectorId: 'mine',
    connectorToken: 'fake-connector-token',
  }
  saveConnectorBinding(f.scoped, testSecrets, original)
  await writeFile(join(f.scoped, 'installation.json'), '{broken')
  const binding = await readConnectorBinding({
    account: f.account,
    secrets: testSecrets,
    key: f.key,
    directory: f.scoped,
  })
  expect(binding).toEqual(original)
  saveConnectorBinding(f.scoped, testSecrets, binding)
  const metadata = await readFile(join(f.scoped, 'installation.json'), 'utf8')
  expect(JSON.parse(metadata)).toEqual({
    installationId: 'stable-installation',
    connectorId: 'mine',
  })
  expect(metadata).not.toContain('token')
})
it('does not rotate or claim a recovered connector owned by a different user', async () => {
  const f = await bindingFixture()
  await mkdir(f.scoped, { recursive: true })
  await writeFile(join(f.scoped, 'binding.enc.json'), unreadable)
  await writeFile(
    join(f.scoped, 'installation.json'),
    JSON.stringify({
      installationId: 'stable-installation',
      connectorId: 'foreign',
    }),
  )
  f.json.mockResolvedValue({ connector: { userId: 'bob' } })
  const connector = new PlatformConnector(
    f.account,
    f.spaces.home,
    testSecrets,
    {
      preparePython: async () => ({
        executable: process.execPath,
        python: 'fake-python',
        environment: {},
      }),
    },
  )
  activeConnectors.push(connector)
  await expect(connector.connect()).rejects.toThrow('归属变化')
  expect(f.json).toHaveBeenCalledExactlyOnceWith('/connectors/foreign')
  expect(connector.state().connectorOnline).toBe(false)
})
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-managed-python-'))
  roots.push(directory)
  return directory
}
it('ignores ambient Python 3.11 and virtualenv choices and explicitly prepares managed 3.12', async () => {
  const directory = await root()
  let finds = 0
  const run = vi.fn(async (_executable: string, args: string[]) => {
    if (args[0] === 'python' && args[1] === 'find') {
      if (++finds === 1) throw new Error('No managed interpreter')
      return join(directory, 'python-3.12')
    }
    if (args[0] === '-I') return '3.12'
    return ''
  })
  const result = await prepareConnectorPython({
    packageFile: join(directory, 'package.json'),
    directory,
    run,
    environment: {
      PATH: 'python-3.11',
      UV_PYTHON: 'python-3.11.exe',
      UV_NO_MANAGED_PYTHON: '1',
      VIRTUAL_ENV: 'foreign-venv',
      PYTHONHOME: 'foreign',
      PYTHONPATH: 'foreign',
    },
  })
  expect(result.python).toBe(join(directory, 'python-3.12'))
  expect(result.environment.UV_PYTHON).toBeUndefined()
  expect(result.environment.VIRTUAL_ENV).toBeUndefined()
  expect(result.environment.UV_NO_MANAGED_PYTHON).toBeUndefined()
  expect(result.environment.UV_PYTHON_INSTALL_DIR).toBe(
    join(directory, 'python'),
  )
  expect(run.mock.calls[0]![1]).toContain('--managed-python')
  expect(run.mock.calls[0]![1]).toContain('--no-python-downloads')
  expect(run.mock.calls[1]![1]).toEqual(
    expect.arrayContaining(['python', 'install', '3.12', '--no-bin']),
  )
})
it('reuses the product interpreter without downloading again, and rejects a wrong executable version', async () => {
  const directory = await root()
  const run = vi.fn(async (_executable: string, args: string[]) =>
    args[0] === 'python' ? join(directory, 'python') : '3.12',
  )
  const options = {
    packageFile: join(directory, 'package.json'),
    directory,
    environment: {},
    run,
  }
  await prepareConnectorPython(options)
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls.flatMap((call) => call[1])).not.toContain('install')
  run.mockImplementation(async (_executable, args) =>
    args[0] === 'python' ? 'python-3.11' : '3.11',
  )
  await expect(prepareConnectorPython(options)).rejects.toThrow('版本校验失败')
})
it('never registers a device if Python preparation fails, and exposes a retryable human status', async () => {
  const directory = await root()
  const spaces = new PlatformSpaces(
    join(directory, 'default'),
    join(directory, 'local'),
  )
  const key = accountSpaceKey('https://a.example', 'alice')
  const json = vi.fn(async () => null)
  const account = {
    spaces,
    identityKey: key,
    origin: 'https://a.example',
    user: { userId: 'alice', resetRequired: false },
    token: async () => 'test-token',
    json,
  } as unknown as PlatformAccount
  const connector = new PlatformConnector(
    account,
    spaces.home,
    {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    {
      preparePython: async () => {
        throw new Error(
          '本机连接需要 Python 3.12。自动准备失败，请检查网络后重试。',
        )
      },
    },
  )
  await expect(connector.connect()).rejects.toThrow('Python 3.12')
  expect(json).not.toHaveBeenCalled()
  expect(connector.state()).toMatchObject({
    connectorPhase: 'error',
    connectorRunning: false,
    connectorId: null,
  })
  await connector.stop()
  expect(connector.state().connectorPhase).toBe('stopped')
})
it('maintains an existing runtime identity while moving its binding to the original local Home', async () => {
  const json = vi.fn(
    async (
      _path: string,
      method?: string,
      _body?: PlatformJson,
    ): Promise<PlatformJson> =>
      method
        ? {
            runtimeId: 'existing',
            runtimeType: 'dsh',
            config: { dshHome: 'original-local-home' },
            active: _path.endsWith('/active'),
            status: _path.endsWith('/active') ? 'running' : 'stopped',
          }
        : {
            runtimes: [
              {
                runtimeType: 'dsh',
                runtimeId: 'existing',
                active: false,
                status: 'stopped',
                config: {
                  dshHome: 'old-account-home',
                  requestTimeoutMs: 60000,
                },
              },
            ],
          },
  )
  await ensureManagedDshRuntime({ json }, 'my-device', 'original-local-home')
  expect(json.mock.calls).toEqual([
    ['/connectors/my-device/runtimes'],
    [
      '/connectors/my-device/runtimes/existing/config',
      'PUT',
      { config: { dshHome: 'original-local-home', requestTimeoutMs: 60000 } },
    ],
    ['/connectors/my-device/runtimes/existing/active', 'PUT', { active: true }],
  ])
  expect(json.mock.calls.some((call) => call[1] === 'POST')).toBe(false)
})
it('creates only a missing DSH runtime and never replaces an already active local binding', async () => {
  const json = vi.fn(
    async (
      _path: string,
      _method?: string,
      _body?: PlatformJson,
    ): Promise<PlatformJson> =>
      _method === 'POST'
        ? {
            runtimeId: 'new-dsh',
            runtimeType: 'dsh',
            active: true,
            status: 'running',
          }
        : { runtimes: [] },
  )
  await ensureManagedDshRuntime({ json }, 'my-device', 'local')
  expect(json.mock.calls[1]).toEqual([
    '/connectors/my-device/runtimes',
    'POST',
    {
      runtimeType: 'dsh',
      name: 'SuperDsh',
      config: { dshHome: 'local' },
      active: true,
    },
  ])
  json.mockClear()
  json.mockResolvedValue({
    runtimes: [
      {
        runtimeType: 'dsh',
        runtimeId: 'existing',
        active: true,
        status: 'running',
        config: { dshHome: 'local' },
      },
    ],
  })
  await ensureManagedDshRuntime({ json }, 'my-device', 'local')
  expect(json).toHaveBeenCalledOnce()
})
it('never treats an active but starting or errored runtime as a ready native Bridge', async () => {
  for (const status of ['starting', 'error']) {
    const runtime = {
      runtimeType: 'dsh',
      runtimeId: 'stable-runtime',
      config: { dshHome: 'local' },
      active: true,
      status,
    }
    const json = vi.fn(
      async (_path: string, method?: string): Promise<PlatformJson> =>
        method ? runtime : { runtimes: [runtime] },
    )
    await expect(
      ensureManagedDshRuntime({ json }, 'mine', 'local'),
    ).rejects.toThrow(status === 'error' ? '启动失败' : '等待本机会话桥接')
    expect(json.mock.calls.some((call) => call[1] === 'POST')).toBe(false)
    if (status === 'error')
      expect(json).toHaveBeenLastCalledWith(
        '/connectors/mine/runtimes/stable-runtime/active',
        'PUT',
        { active: true },
      )
  }
})
it('isolates per-identity checkpoints but shares the product Python installation cache', () => {
  const environment = connectorPythonEnvironment(
    { UV_PYTHON: 'wrong', UV_CACHE_DIR: 'wrong' },
    'shared-runtime',
  )
  expect(environment.UV_CACHE_DIR).toBe(join('shared-runtime', 'uv-cache'))
  expect(environment.UV_PYTHON).toBeUndefined()
})
it('preserves a real child startup error and reuses only the returning identity binding', async () => {
  const directory = await root()
  const spaces = new PlatformSpaces(
    join(directory, 'default'),
    join(directory, 'local'),
  )
  let selected = 'alice'
  const registered: string[] = []
  const keys = {
    alice: accountSpaceKey('https://a.example', 'alice'),
    bob: accountSpaceKey('https://a.example', 'bob'),
  }
  const json = vi.fn(
    async (path: string, method?: string): Promise<PlatformJson> => {
      if (method === 'POST') {
        registered.push(selected)
        return {
          connector: { id: 'device-' + selected, userId: selected },
          connectorToken: 'fake-connector-token',
        }
      }
      expect(path).toBe('/connectors/device-' + selected)
      return { connector: { userId: selected } }
    },
  )
  const account = {
    spaces,
    get identityKey() {
      return keys[selected as keyof typeof keys]
    },
    origin: 'https://a.example',
    get user() {
      return { userId: selected, resetRequired: false }
    },
    token: async () => 'test-token',
    json,
  } as unknown as PlatformAccount
  const diagnostic = vi.fn()
  const phases: string[] = []
  const connector = new PlatformConnector(
    account,
    spaces.home,
    {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    {
      // A real owned child rejects uv CLI flags immediately; no model/server/engine is launched.
      preparePython: async () => ({
        executable: process.execPath,
        python: 'fake-python',
        environment: {},
      }),
      diagnostic,
      changed: () => {
        phases.push(connector.state().connectorPhase)
      },
    },
  )
  await expect(connector.connect()).rejects.toThrow('本机平台连接已停止')
  expect(connector.state()).toMatchObject({
    connectorPhase: 'error',
    connectorRunning: false,
  })
  expect(phases).toContain('preparing-dependencies')
  expect(diagnostic).toHaveBeenCalled()
  await connector.stop()
  selected = 'bob'
  await expect(connector.connect()).rejects.toThrow()
  await connector.stop()
  selected = 'alice'
  await expect(connector.connect()).rejects.toThrow()
  await connector.stop()
  expect(registered).toEqual(['alice', 'bob'])
  const alice = JSON.parse(
    await readFile(
      join(spaces.directoryFor(keys.alice), 'connector', 'binding.enc.json'),
      'utf8',
    ),
  ) as { encrypted: string }
  const bob = JSON.parse(
    await readFile(
      join(spaces.directoryFor(keys.bob), 'connector', 'binding.enc.json'),
      'utf8',
    ),
  ) as { encrypted: string }
  expect(Buffer.from(alice.encrypted, 'base64').toString()).toContain(
    'device-alice',
  )
  expect(Buffer.from(bob.encrypted, 'base64').toString()).toContain(
    'device-bob',
  )
  expect(spaces.home).toBe(spaces.localHome)
})
it('refuses a legacy binding owned by another user before spawning or registering a device', async () => {
  const directory = await root()
  const spaces = new PlatformSpaces(
    join(directory, 'default'),
    join(directory, 'local'),
  )
  const key = accountSpaceKey('https://a.example', 'alice')
  const legacy = join(spaces.homeFor(key), 'platform-connector')
  await mkdir(legacy, { recursive: true })
  await writeFile(
    join(legacy, 'binding.enc.json'),
    JSON.stringify({
      encrypted: Buffer.from(
        JSON.stringify({
          installationId: 'test-installation',
          connectorId: 'foreign',
          connectorToken: 'foreign-token',
        }),
      ).toString('base64'),
    }),
  )
  const json = vi.fn(async (): Promise<PlatformJson> => ({
    connector: { userId: 'bob' },
  }))
  const account = {
    spaces,
    identityKey: key,
    origin: 'https://a.example',
    user: { userId: 'alice', resetRequired: false },
    token: async () => 'test-token',
    json,
  } as unknown as PlatformAccount
  const connector = new PlatformConnector(
    account,
    spaces.home,
    {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    {
      preparePython: async () => ({
        executable: process.execPath,
        python: 'fake-python',
        environment: {},
      }),
    },
  )
  await expect(connector.connect()).rejects.toThrow('不属于当前账号')
  expect(json).toHaveBeenCalledExactlyOnceWith('/connectors/foreign')
  await connector.stop()
  expect(await readFile(join(legacy, 'binding.enc.json'), 'utf8')).toContain(
    'encrypted',
  )
})

async function controlFixture(connected = true) {
  const f = await bindingFixture()
  const script = join(f.directory, 'control-fixture.cjs')
  await writeFile(
    script,
    `const { createInterface } = require('node:readline')
let state = { running: false, connected: false, authFailed: false }
const notify = () => process.stdout.write(JSON.stringify({ method: 'connector/state', params: state }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'connector.start') {
    state = { running: true, connected: process.argv[2] === 'online', authFailed: false }
    notify()
    process.stdout.write(JSON.stringify({ method: 'connector/log', params: { message: 'token=' + frame.params.connectorToken } }) + '\\n')
  } else if (frame.method === 'connector.stop') {
    state = { running: false, connected: false, authFailed: false }
    notify()
  } else if (frame.method === 'fixture.disconnect' || frame.method === 'fixture.connect') {
    state.connected = frame.method === 'fixture.connect'
    notify()
  }
  if (frame.id !== undefined) process.stdout.write(JSON.stringify({ id: frame.id, result: state }) + '\\n')
})
`,
  )
  let child: ChildProcessWithoutNullStreams | undefined
  let status = 'online'
  const presence = () => ({ connector: { userId: 'alice', status } })
  f.json.mockImplementation(async (path, method): Promise<PlatformJson> => {
    if (path === '/connectors' && method === 'POST')
      return {
        connector: { id: 'fixture-device', userId: 'alice' },
        connectorToken: 'fake-connector-token',
      }
    if (path === '/connectors/fixture-device') return presence()
    if (path === '/connectors/fixture-device/runtimes')
      return {
        runtimes: [
          {
            runtimeId: 'stable-runtime',
            runtimeType: 'dsh',
            config: { dshHome: f.spaces.home },
            active: true,
            status: 'running',
          },
        ],
      }
    throw new Error('Unexpected fixture API route')
  })
  const diagnostic = vi.fn()
  const connector = new PlatformConnector(
    f.account,
    f.spaces.home,
    testSecrets,
    {
      preparePython: async () => ({
        executable: process.execPath,
        python: 'fake-python',
        environment: {},
      }),
      spawnConnector: () => {
        child = spawn(
          process.execPath,
          [script, connected ? 'online' : 'offline'],
          {
            stdio: 'pipe',
            windowsHide: true,
          },
        )
        return child
      },
      connectionTimeoutMs: 150,
      presenceIntervalMs: 20,
      diagnostic,
    },
  )
  activeConnectors.push(connector)
  return {
    ...f,
    connector,
    diagnostic,
    child: () => child!,
    presence,
    status: (value: string) => {
      status = value
    },
  }
}
it('requires a real transport handshake and server presence instead of merely a running control task', async () => {
  const f = await controlFixture(false)
  await expect(f.connector.connect()).rejects.toThrow('尚未连通平台')
  expect(f.connector.state()).toMatchObject({
    connectorOnline: false,
    connectorRunning: false,
    connectorPhase: 'error',
  })
  expect(f.json.mock.calls.some((call) => call[0].endsWith('/runtimes'))).toBe(
    false,
  )
})
it('tracks disconnect and reconnect accurately and never writes or logs the Connector token in plaintext', async () => {
  const f = await controlFixture()
  await f.connector.connect()
  expect(f.connector.state()).toMatchObject({
    connectorRunning: true,
    connectorOnline: true,
    connectorPhase: 'ready',
  })
  expect(
    await readFile(join(f.scoped, 'connector.json'), 'utf8'),
  ).not.toContain('connectorToken')
  expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(
    'fake-connector-token',
  )
  f.child().stdin.write(JSON.stringify({ method: 'fixture.disconnect' }) + '\n')
  await vi.waitFor(() =>
    expect(f.connector.state()).toMatchObject({
      connectorRunning: true,
      connectorOnline: false,
      connectorPhase: 'reconnecting',
    }),
  )
  const ownedChild = f.child()
  await expect(f.connector.connect()).rejects.toThrow('仍在重新连接')
  expect(f.child()).toBe(ownedChild)
  expect(f.connector.state().connectorPhase).toBe('reconnecting')
  f.child().stdin.write(JSON.stringify({ method: 'fixture.connect' }) + '\n')
  await vi.waitFor(() => expect(f.connector.state().connectorOnline).toBe(true))
  f.status('offline')
  await vi.waitFor(() =>
    expect(f.connector.state().connectorOnline).toBe(false),
  )
  f.status('online')
  await vi.waitFor(() =>
    expect(f.connector.state()).toMatchObject({
      connectorOnline: true,
      connectorPhase: 'ready',
    }),
  )
})
it('keeps the new generation presence supervisor after a previous request finishes late', async () => {
  const f = await controlFixture()
  await f.connector.connect()
  const normal = f.json.getMockImplementation()!
  let settle!: (value: PlatformJson) => void
  let entered = false
  const deferred = new Promise<PlatformJson>((resolve) => {
    settle = resolve
  })
  f.json.mockImplementation(async (path, method, body) => {
    if (path === '/connectors/fixture-device' && !entered) {
      entered = true
      return deferred
    }
    return normal(path, method, body)
  })
  await vi.waitFor(() => expect(entered).toBe(true))
  await f.connector.stop()
  await f.connector.connect()
  const observed = f.json.mock.calls.length
  settle(f.presence())
  await vi.waitFor(() =>
    expect(f.json.mock.calls.length).toBeGreaterThan(observed + 1),
  )
  expect(f.connector.state()).toMatchObject({
    connectorOnline: true,
    connectorPhase: 'ready',
  })
})
