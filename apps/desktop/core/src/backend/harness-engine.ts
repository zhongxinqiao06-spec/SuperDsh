/** Fixed DSH integration owned by the product. Only the child loads the engine's plugin graph. */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { desktopRuntimeAssets } from '../main/installation.ts'
import { fileURLToPath } from 'node:url'
import { DesktopHostProcess } from './host-process.ts'
import { authenticateWebHost } from './web-auth.ts'
import { SYSTEM_PROXY_ENV } from './system-proxy.ts'
import type { RuntimeOptions } from './desktop-runtime.ts'
import type { DesktopPreferences } from '../contracts/desktop-contract.ts'

export interface HarnessConnection {
  readonly url: string
  readonly cookie: string
  readonly token: string
  readonly injections: readonly unknown[]
}
export interface HarnessEngineOptions {
  readonly runtime: RuntimeOptions
  readonly home: string
  readonly profileDirectory: string
  readonly preferences: DesktopPreferences
  readonly addresses: readonly string[]
  readonly safeMode: boolean
  readonly onFailure: (error: Error) => void
  readonly onLog: (chunk: string) => void
}
type ProcessFactory = (
  ...args: ConstructorParameters<typeof DesktopHostProcess>
) => DesktopHostProcess

/** One required engine generation; lifecycle serialization remains the application controller's job. */
export class HarnessEngineFacade {
  readonly id = 'dsh' as const
  readonly host: DesktopHostProcess
  private readonly token = randomBytes(32).toString('base64url')

  constructor(
    options: HarnessEngineOptions,
    createProcess: ProcessFactory = (...args) =>
      new DesktopHostProcess(...args),
  ) {
    const { runtime } = options
    this.host = createProcess(
      runtime.executable,
      runtime.root,
      options.profileDirectory,
      undefined,
      {
        ...process.env,
        DSH_HOME: options.home,
        SUPERDSH_PLATFORM_MANAGED:
          runtime.managedPlatform && !options.safeMode ? '1' : '0',
        SUPERDSH_MODEL_GATEWAY:
          runtime.managedPlatform && !options.safeMode
            ? JSON.stringify(runtime.modelGateway?.())
            : '',
        DSH_NEXT_NATIVE_TOKEN: this.token,
        SUPERDSH_CLIENT_MANIFEST:
          runtime.frontendManifest ??
          desktopRuntimeAssets(join(runtime.root, 'package.json'))
            .frontendManifest,
        DSH_NEXT_PREFERENCES: JSON.stringify(options.preferences),
        DSH_NEXT_TRUSTED_HOSTS: JSON.stringify(options.addresses),
        [SYSTEM_PROXY_ENV]: JSON.stringify(runtime.systemProxy?.() ?? {}),
        ...(options.safeMode ? { DSH_TELEMETRY_DISABLED: '1' } : {}),
      },
      options.onFailure,
      undefined,
      undefined,
      fileURLToPath(import.meta.resolve('@superdsh/core/backend/host')),
      runtime.onRestart,
      runtime.onNotification,
      options.onLog,
      runtime.onTerminal,
      runtime.onPermission,
      undefined,
      runtime.onPlatformLogin,
    )
  }

  /** A ready child alone is insufficient: require its loopback transport, graph and native authority. */
  async start(): Promise<HarnessConnection> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = await Promise.race([
      this.host.start(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Host startup exceeded 60 seconds')),
          60_000,
        )
        timer.unref()
      }),
    ]).finally(() => clearTimeout(timer))
    const url = new URL(ready.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('Next Host must use loopback HTTP')
    if (!ready.injections)
      throw new Error('Next Host omitted Web boot injections')
    const cookie = await authenticateWebHost(ready.url, this.token)
    return {
      url: ready.url,
      cookie,
      token: this.token,
      injections: ready.injections,
    }
  }

  stop(requireGraceful = false): Promise<void> {
    return this.host.stop(requireGraceful)
  }
}
