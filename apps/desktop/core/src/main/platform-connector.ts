/** Own one Connector child and scoped credentials while every identity uses the local Home. */
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { HARNESS_PACKAGE } from './profiles.ts'
import { atomicJson } from '../backend/private-files.ts'
import type {
  PlatformAccount,
  PlatformSecretStore,
} from './platform-account.ts'
import type {
  PlatformConnectorPhase,
  PlatformJson,
} from '../contracts/platform.ts'
import { accountEnvironment } from '../backend/platform-environment.ts'
import { maskSecrets } from '../backend/mask-secrets.ts'
import {
  prepareConnectorPython,
  type ConnectorPythonOptions,
  type ConnectorPython,
} from './platform-connector-python.ts'
import {
  readConnectorBinding,
  saveConnectorBinding,
  type ConnectorBinding,
} from './platform-connector-binding.ts'

/** The embedding API keeps the runtime set fixed and rejects another account's Home. */
export const MANAGED_CONNECTOR_PYTHON = `import asyncio, os, sys
from pathlib import Path
from connector.control import ConnectorController
from connector.core.json_rpc import open_stdio_server
from connector.core.runtime_owner import RuntimeLease
from connector.server.client import BackendRpcClient
from connector.runtimes.dsh.provider import DshProvider
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.logging import configure_connector_logging, install_rpc_log_sink

class ProductDshProvider(DshProvider):
    async def validate_config(self, values):
        expected = Path(os.environ['DSH_HOME']).resolve()
        selected = Path(values.get('dshHome') or expected).resolve()
        if selected != expected:
            raise RuntimeInvalidRequestError('Runtime belongs to another account space')
        return await super().validate_config({**values, 'dshHome': str(expected)})
    async def create_runtime(self, config, host):
        if Path(config.values.get('dshHome') or os.environ['DSH_HOME']).resolve() != Path(os.environ['DSH_HOME']).resolve():
            raise RuntimeInvalidRequestError('Runtime belongs to another account space')
        return await super().create_runtime(config, host)

async def main():
    server = None
    client = None
    async def notify(method, params):
        if server is not None:
            await server.notify(method, params)
    def create_client(config):
        nonlocal client
        client = BackendRpcClient(config, agent_runtime_providers=(ProductDshProvider(),))
        return client
    controller = ConnectorController(config_path=sys.argv[1], notifier=notify,
        client_factory=create_client)
    def state(params=None):
        values = controller.get_state(params)
        values['connected'] = client is not None and client._rpc.connected
        return values
    async def monitor():
        previous = None
        while True:
            values = state()
            current = (values['running'], values['connected'], values['authFailed'], values['lastError'])
            if current != previous:
                await notify('connector/state', values)
                previous = current
            await asyncio.sleep(1)
    controller.runtime_path = Path(os.environ['AGENT_CONNECTOR_DATA_DIR']) / 'runtime.json'
    controller.lease = RuntimeLease(controller.runtime_path, kind='superdsh', legacy_paths=[])
    sink = install_rpc_log_sink(notify, level='INFO', remove_default_sink=True)
    server = await open_stdio_server({'connector.getState': state,
        'connector.start': controller.start, 'connector.stop': controller.stop})
    monitoring = asyncio.create_task(monitor())
    try:
        await server.serve_forever()
    finally:
        monitoring.cancel()
        await asyncio.gather(monitoring, return_exceptions=True)
        await controller.shutdown()
        await sink.close()

configure_connector_logging(debug=False)
asyncio.run(main())
`

export interface PlatformConnectorOptions {
  changed?(): void
  diagnostic?(message: string): void
  preparePython?(options: ConnectorPythonOptions): Promise<ConnectorPython>
  spawnConnector?(
    executable: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams
  presenceIntervalMs?: number
  connectionTimeoutMs?: number
}
export async function ensureManagedDshRuntime(
  account: Pick<PlatformAccount, 'json'>,
  connectorId: string,
  home: string,
  assertCurrent?: () => void,
): Promise<void> {
  interface ManagedRuntime {
    runtimeId: string
    runtimeType: string
    config?: Record<string, PlatformJson> | null
    active?: boolean
    status?: string
    error?: PlatformJson
  }
  const base = '/connectors/' + encodeURIComponent(connectorId) + '/runtimes'
  assertCurrent?.()
  const result = (await account.json(base)) as {
    runtimes?: ManagedRuntime[]
  }
  assertCurrent?.()
  const dsh = result.runtimes?.find((runtime) => runtime.runtimeType === 'dsh')
  let current: ManagedRuntime
  if (!dsh) {
    current = (await account.json(base, 'POST', {
      runtimeType: 'dsh',
      name: 'SuperDsh',
      config: { dshHome: home },
      active: true,
    })) as unknown as ManagedRuntime
    assertCurrent?.()
  } else {
    current = dsh
    const path = base + '/' + encodeURIComponent(dsh.runtimeId)
    if (dsh.config?.dshHome !== home) {
      current = (await account.json(path + '/config', 'PUT', {
        config: { ...dsh.config, dshHome: home },
      })) as unknown as ManagedRuntime
      assertCurrent?.()
    }
    if (
      current.active !== true ||
      (current.status !== 'running' && current.status !== 'starting')
    ) {
      current = (await account.json(path + '/active', 'PUT', {
        active: true,
      })) as unknown as ManagedRuntime
      assertCurrent?.()
    }
  }
  if (current.status !== 'running' || current.active !== true)
    throw new Error(
      current.status === 'error'
        ? '本机会话桥接启动失败，请检查连接诊断后重试。'
        : '正在等待本机会话桥接就绪。',
      { cause: maskSecrets(JSON.stringify(current.error ?? null)) },
    )
}
class IdentityPlatformConnector {
  private child: ChildProcessWithoutNullStreams | undefined
  private binding: ConnectorBinding | undefined
  private pending = new Map<
    number,
    {
      resolve(value: PlatformJson): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private sequence = 0
  private generation = 0
  private running = false
  private transportConnected = false
  private online = false
  private configured = false
  private presenceTimer: ReturnType<typeof setTimeout> | undefined
  private operation: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private error: string | null = null
  private phase: PlatformConnectorPhase = 'stopped'
  private controller = new AbortController()
  constructor(
    private readonly account: PlatformAccount,
    readonly home: string,
    private readonly secrets: PlatformSecretStore,
    readonly key: string,
    private readonly directory: string,
    private readonly options: PlatformConnectorOptions,
  ) {}
  state(): {
    connectorId: string | null
    connectorRunning: boolean
    connectorOnline: boolean
    error: string | null
    connectorPhase: PlatformConnectorPhase
  } {
    return {
      connectorId: this.binding?.connectorId ?? null,
      connectorRunning: this.running,
      connectorOnline: this.online,
      error: this.error,
      connectorPhase: this.phase,
    }
  }
  async connect(): Promise<void> {
    if (this.child && !this.running && !this.operation) await this.stop()
    if (!this.operation) this.controller = new AbortController()
    const generation = this.generation
    this.operation ??= this.start(generation)
      .catch((error: unknown) => {
        const cancelled = generation !== this.generation
        this.error = cancelled
          ? null
          : error instanceof Error
            ? error.message
            : '本机平台连接失败'
        this.setPhase(
          cancelled ? 'stopped' : this.running ? 'reconnecting' : 'error',
        )
        if (!cancelled && error instanceof Error && error.cause)
          this.options.diagnostic?.(
            maskSecrets(String(error.cause)).slice(-8000),
          )
        throw error
      })
      .finally(() => {
        this.operation = undefined
      })
    return this.operation
  }
  private async start(generation: number): Promise<void> {
    if (this.running) {
      if (this.configured && this.online && this.phase === 'ready') return
      throw new Error('本机仍在重新连接平台，请稍后重试。')
    }
    if (this.stopping) await this.stopping
    if (this.account.identityKey !== this.key)
      throw new Error('连接身份已变化，请重新连接。')
    await this.account.token()
    if (generation !== this.generation) throw new Error('连接已取消')
    if (this.account.user.resetRequired)
      throw new Error('请先修改临时密码后重新登录。')
    if (!this.secrets.isEncryptionAvailable())
      throw new Error('系统凭据加密不可用')
    this.binding ??= await readConnectorBinding({
      account: this.account,
      secrets: this.secrets,
      key: this.key,
      directory: this.directory,
      diagnostic: this.options.diagnostic,
    })
    const save = () =>
      saveConnectorBinding(this.directory, this.secrets, this.binding!)
    save()
    this.setPhase('preparing-python')
    const packageFile = createRequire(HARNESS_PACKAGE).resolve(
      '@agents-anywhere/dsh-bridge-next/package.json',
    )
    const payload = join(
      dirname(packageFile),
      'lib',
      'bundled-connector',
    ).replace(/\.asar([\\/])/, '.asar.unpacked$1')
    const prepared = await (
      this.options.preparePython ?? prepareConnectorPython
    )({
      packageFile,
      directory: join(this.account.spaces.root, 'runtime'),
      environment: accountEnvironment(process.env, this.home),
      signal: this.controller.signal,
      diagnostic: this.options.diagnostic,
    })
    this.assertCurrent(generation)
    this.setPhase('registering')
    if (!this.binding.connectorId) {
      const created = (await this.account.json('/connectors', 'POST', {
        name: hostname(),
        connectorKind: 'cli',
        installationId: this.binding.installationId,
      })) as {
        connector: { id: string; userId: string }
        connectorToken: string
      }
      if (
        created.connector.userId !== this.account.user.userId ||
        !created.connectorToken
      )
        throw new Error('设备归属校验失败')
      this.binding = {
        ...this.binding,
        connectorId: created.connector.id,
        connectorToken: created.connectorToken,
      }
      save()
    } else {
      const current = (await this.account.json(
        `/connectors/${encodeURIComponent(this.binding.connectorId)}`,
      )) as { connector: { userId: string; blockedAt?: string | null } }
      if (
        current.connector.userId !== this.account.user.userId ||
        current.connector.blockedAt
      )
        throw new Error('设备已被停用或归属变化，不能恢复连接。')
      if (!this.binding.connectorToken) {
        const recovered = (await this.account.json(
          `/connectors/${encodeURIComponent(this.binding.connectorId)}/revoke`,
          'POST',
          {},
        )) as {
          connector: { id: string; userId: string }
          connectorToken: string
        }
        if (
          recovered.connector.id !== this.binding.connectorId ||
          recovered.connector.userId !== this.account.user.userId ||
          !recovered.connectorToken
        )
          throw new Error('无法恢复本机设备凭据')
        this.binding.connectorToken = recovered.connectorToken
        save()
      }
    }
    if (generation !== this.generation) throw new Error('连接已取消')
    this.assertCurrent(generation)
    const config = join(this.directory, 'connector.json')
    const connection = {
      serverUrl: this.account.origin,
      connectorId: this.binding.connectorId,
      statePath: join(this.directory, 'sync.sqlite3'),
      heartbeatSeconds: 20,
      reconnectSeconds: 3,
      syncExistingOnConnect: true,
      syncIntervalSeconds: 30,
    }
    // Controller.start accepts the secret over stdio; disk keeps only connection metadata.
    atomicJson(config, connection)
    const launcher = join(this.directory, 'superdsh-connector.py')
    await writeFile(launcher, MANAGED_CONNECTOR_PYTHON, { mode: 0o600 })
    if (generation !== this.generation) throw new Error('连接已取消')
    const environment: NodeJS.ProcessEnv = {
      ...prepared.environment,
      DSH_HOME: this.home,
      AGENT_CONNECTOR_DATA_DIR: this.directory,
      AA_CONNECTOR_OWNER_KIND: 'superdsh',
      UV_PROJECT_ENVIRONMENT: join(this.directory, 'venv'),
      UV_PYTHON_DOWNLOADS: 'never',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    }
    for (const key of ['NO_PROXY', 'no_proxy']) {
      const value = environment[key]
      if (value) environment[key] = value.replaceAll('[::1]', '::1')
    }
    this.setPhase('preparing-dependencies')
    const startProcess =
      this.options.spawnConnector ??
      ((
        executable: string,
        args: string[],
        options: SpawnOptionsWithoutStdio,
      ) => spawn(executable, args, { ...options, stdio: 'pipe' }))
    const child = startProcess(
      prepared.executable,
      [
        'run',
        '--no-config',
        '--no-project',
        '--managed-python',
        '--python',
        prepared.python,
        '--with',
        payload,
        'python',
        launcher,
        config,
      ],
      {
        cwd: payload,
        env: environment,
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    )
    this.child = child
    let buffer = '',
      diagnostics = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1024 * 1024) {
        this.fail(new Error('Connector frame exceeded limit'))
        void this.stop()
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const frame = JSON.parse(line) as {
            id?: number
            method?: string
            result?: PlatformJson
            error?: { message?: string }
            params?: {
              running?: boolean
              connected?: boolean
              authFailed?: boolean
              lastError?: string | null
              message?: string
              exception?: string
              level?: string
            }
          }
          if (frame.method === 'connector/state')
            this.controlState(frame.params, save)
          if (frame.method === 'connector/log' && frame.params?.message)
            this.options.diagnostic?.(
              maskSecrets(
                'Connector [' +
                  (frame.params.level ?? 'INFO') +
                  ']: ' +
                  frame.params.message +
                  (frame.params.exception ? '\n' + frame.params.exception : ''),
              ).slice(-2000),
            )
          if (frame.id !== undefined) {
            const pending = this.pending.get(frame.id)
            if (pending) {
              this.pending.delete(frame.id)
              clearTimeout(pending.timer)
              if (frame.error)
                pending.reject(
                  new Error(frame.error.message ?? 'Connector 请求失败'),
                )
              else pending.resolve(frame.result ?? null)
            }
          }
        } catch {
          this.fail(new Error('Connector 返回无效控制消息'))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const safe = maskSecrets(chunk)
      diagnostics = (diagnostics + safe).slice(-8000)
      this.options.diagnostic?.('Connector: ' + safe.slice(-2000))
    })
    child.on('error', () =>
      this.fail(new Error('Connector 启动失败，请检查 uv/Python 环境。')),
    )
    child.on('close', () => {
      if (this.child === child) {
        this.child = undefined
        this.running = false
        this.online = false
        this.transportConnected = false
        clearTimeout(this.presenceTimer)
        const message = /memory allocation .* failed|out of memory/i.test(
          diagnostics,
        )
          ? '连接依赖安装或运行时内存不足，请释放内存后重试；已下载的依赖会保留。'
          : '本机平台连接已停止，请检查连接状态后重试。'
        this.fail(
          new Error(message, {
            cause: diagnostics,
          }),
        )
        if (this.stopping) this.error = null
      }
    })
    child.stdin.on('error', () =>
      this.fail(new Error('Connector 控制通道已关闭')),
    )
    try {
      this.controlState(await this.call('connector.getState', 600_000), save)
      if (generation !== this.generation) throw new Error('连接已取消')
      this.setPhase('starting')
      this.controlState(
        await this.call('connector.start', 30_000, {
          ...connection,
          connectorId: this.binding.connectorId!,
          connectorToken: this.binding.connectorToken!,
        }),
        save,
      )
      this.assertCurrent(generation)
      if (!this.running)
        throw new Error(this.error ?? '本机连接未能启动，请重新连接。')
      this.error = null
      this.setPhase('syncing')
      const connectorId = this.binding.connectorId!
      const deadline = Date.now() + (this.options.connectionTimeoutMs ?? 30_000)
      // A control task can run while its socket keeps failing. Verify server presence first.
      for (;;) {
        try {
          this.assertCurrent(generation)
          if (!this.running)
            throw new Error(this.error ?? '本机连接未能启动，请重新连接。')
          if (!(await this.verifyPresence(generation)))
            throw new Error('本机尚未连通平台，正在等待连接握手。')
          await ensureManagedDshRuntime(
            this.account,
            connectorId,
            this.home,
            () => this.assertCurrent(generation),
          )
          break
        } catch (error) {
          if (!this.running || Date.now() >= deadline) throw error
          await delay(this.options.presenceIntervalMs ?? 1000)
          if (this.child !== child)
            throw new Error('连接已取消', { cause: error })
        }
      }
      this.assertCurrent(generation)
      this.configured = true
      this.setPhase('ready')
      this.schedulePresence(generation)
    } catch (error) {
      await this.stop(false)
      throw error
    }
  }
  private fail(error: Error): void {
    this.error = error.message
    if (error.cause)
      this.options.diagnostic?.(maskSecrets(String(error.cause)).slice(-8000))
    this.setPhase('error')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  private setPhase(phase: PlatformConnectorPhase): void {
    this.phase = phase
    this.options.changed?.()
  }
  private assertCurrent(generation: number): void {
    if (
      generation !== this.generation ||
      this.controller.signal.aborted ||
      this.account.identityKey !== this.key
    )
      throw new Error('连接已取消')
  }
  private controlState(value: unknown, save: () => void): void {
    if (!value || typeof value !== 'object') return
    const state = value as {
      running?: boolean
      connected?: boolean
      authFailed?: boolean
      lastError?: string | null
    }
    if (typeof state.running === 'boolean') this.running = state.running
    if (typeof state.connected === 'boolean')
      this.transportConnected = state.connected
    if (!this.running || !this.transportConnected) this.online = false
    if (this.stopping) return
    if (state.authFailed) {
      this.running = false
      this.online = false
      if (this.binding?.connectorToken) {
        delete this.binding.connectorToken
        save()
      }
      this.fail(new Error('设备凭据已撤销或停用，请重新连接。'))
      return
    }
    if (state.lastError)
      this.options.diagnostic?.(
        'Connector: ' + maskSecrets(state.lastError).slice(-2000),
      )
    if (!this.running && this.configured) {
      this.fail(new Error('本机平台连接已停止，请重新连接。'))
      return
    }
    if (this.configured && !this.online) this.setPhase('reconnecting')
  }
  private async verifyPresence(generation: number): Promise<boolean> {
    this.assertCurrent(generation)
    const child = this.child
    const result = (await this.account.json(
      '/connectors/' + encodeURIComponent(this.binding!.connectorId!),
    )) as {
      connector: {
        userId: string
        status: string
        blockedAt?: string | null
      }
    }
    this.assertCurrent(generation)
    if (this.child !== child) throw new Error('连接已取消')
    if (
      result.connector.userId !== this.account.user.userId ||
      result.connector.blockedAt
    )
      throw new Error('设备已被停用或归属变化，不能恢复连接。')
    this.online =
      this.running &&
      this.transportConnected &&
      result.connector.status === 'online'
    if (this.configured && this.running) {
      this.error = null
      if (!this.online) this.setPhase('reconnecting')
    }
    return this.online
  }
  private schedulePresence(generation: number): void {
    if (
      this.controller.signal.aborted ||
      generation !== this.generation ||
      !this.child ||
      !this.running
    )
      return
    clearTimeout(this.presenceTimer)
    this.presenceTimer = setTimeout(() => {
      void this.verifyPresence(generation)
        .then(async (online) => {
          if (!online) return
          this.assertCurrent(generation)
          await ensureManagedDshRuntime(
            this.account,
            this.binding!.connectorId!,
            this.home,
            () => this.assertCurrent(generation),
          )
          this.assertCurrent(generation)
          this.error = null
          this.setPhase('ready')
        })
        .catch((error: unknown) => {
          if (generation !== this.generation || this.controller.signal.aborted)
            return
          this.online = false
          this.error =
            error instanceof Error
              ? maskSecrets(error.message).slice(0, 180)
              : '本机与平台的连接暂不可用，请检查连接状态后重试。'
          this.setPhase(this.running ? 'reconnecting' : 'error')
          this.options.diagnostic?.(maskSecrets(String(error)))
        })
        .finally(() => this.schedulePresence(generation))
    }, this.options.presenceIntervalMs ?? 5000)
    this.presenceTimer.unref()
  }
  private call(
    method: string,
    timeout = 30_000,
    params?: PlatformJson,
  ): Promise<PlatformJson> {
    if (!this.child) return Promise.reject(new Error('Connector 未启动'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Connector 响应超时'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      )
    })
  }
  stop(cancelStart = true): Promise<void> {
    if (cancelStart) this.generation++
    this.controller.abort()
    clearTimeout(this.presenceTimer)
    this.online = false
    this.transportConnected = false
    this.configured = false
    this.stopping ??= (async () => {
      const child = this.child
      if (!child) {
        await unlink(join(this.directory, 'connector.json')).catch(() => {})
        this.running = false
        this.setPhase('stopped')
        return
      }
      await this.call('connector.stop', 3000).catch(() => {})
      child.stdin.end()
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve()
        else child.once('close', () => resolve())
      })
      await Promise.race([exited, delay(2000)])
      if (child.exitCode === null) {
        if (process.platform === 'win32' && child.pid)
          await promisify(execFile)(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true },
          ).catch(() => {})
        else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* already exited */
          }
        }
      }
      await exited
      this.running = false
      this.setPhase('stopped')
      await unlink(join(this.directory, 'connector.json')).catch(() => {})
    })().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }
}

/** Rebind one child to an identity-specific checkpoint tree without changing DSH_HOME. */
export class PlatformConnector {
  private current: IdentityPlatformConnector | undefined
  private operation: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private generation = 0
  constructor(
    private readonly account: PlatformAccount,
    readonly home: string,
    private readonly secrets: PlatformSecretStore,
    private readonly options: PlatformConnectorOptions = {},
  ) {}
  state(): {
    connectorId: string | null
    connectorRunning: boolean
    connectorOnline: boolean
    connectorPhase: PlatformConnectorPhase
    error: string | null
  } {
    return this.current?.key === this.account.identityKey
      ? this.current.state()
      : {
          connectorId: null,
          connectorRunning: false,
          connectorOnline: false,
          connectorPhase: 'stopped',
          error: null,
        }
  }
  connect(): Promise<void> {
    if (this.operation) return this.operation
    const generation = this.generation
    const operation = (async () => {
      await this.stopping
      if (generation !== this.generation) throw new Error('连接已取消')
      const key = this.account.identityKey
      if (!key) throw new Error('请先登录管理平台。')
      if (this.current?.key !== key) {
        await this.current?.stop()
        this.current = new IdentityPlatformConnector(
          this.account,
          this.home,
          this.secrets,
          key,
          join(this.account.spaces.directoryFor(key), 'connector'),
          this.options,
        )
      }
      await this.current.connect()
    })().finally(() => {
      if (this.operation === operation) this.operation = undefined
    })
    this.operation = operation
    return operation
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.generation++
    const operation = this.operation
    const stopping = (async () => {
      await this.current?.stop()
      await operation?.catch(() => {})
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = undefined
    })
    this.stopping = stopping
    return stopping
  }
}
