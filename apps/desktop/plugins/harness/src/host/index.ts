/** Alpha.2 shared Web profile runner, hosted by an Electron Node-mode child. */
import { basename, delimiter, dirname, join } from 'node:path'
import { frontendRuntimePatch } from '../frontend-manifest.ts'
import { inspect } from 'node:util'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { startHarnessHost } from '../host-runtime.ts'
import * as clientModuleImplementation from '@deepseek-ai/dsh-client-modules'
import * as webAppImplementation from '@deepseek-ai/dsh-web-app'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loadNextProfile, NEXT_PACKAGE } from '../profiles.ts'
import { bundledPnpmEntry } from '../extensions.ts'
import { withDesktopPnpmPolicy } from '../pnpm-policy.ts'
import { configureNextBrowserAccess } from '../desktop-browser-access.ts'
import { parsePreferences } from '../desktop-preferences.ts'
import { atomicJson } from '../private-files.ts'
import type NextWebServer from '../webserver.ts'
import { disableAsarArchiveView } from '../asar-archive-policy.ts'
import { maskSecrets } from '../mask-secrets.ts'
import {
  parseSystemProxyProbe,
  SYSTEM_PROXY_ENV,
  withSystemProxy,
} from '../system-proxy.ts'
import {
  watchPlatformLogin,
  type PlatformLoginAccount,
} from './platform-login.ts'
import {
  inspectPlatformTasks,
  stopPlatformTasks,
  refreshPlatformModels,
} from './platform-control.ts'

export async function main(): Promise<void> {
  // The Host lists and reads user workspaces; see asar-archive-policy.ts.
  disableAsarArchiveView(import.meta.url)
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  const home = process.env.DSH_HOME
  if (!runtimeDir || !projectDir || !home || !process.send)
    throw new Error('Next Host requires runtime, profile, home and IPC')
  if (
    (clientModuleImplementation as Record<string, unknown>)
      .superdshClientArtifactManifestVersion !== 1
  ) {
    throw new Error(
      'SuperDsh requires the patched Harness frontend artifact registry (version 1)',
    )
  }
  if (
    (webAppImplementation as Record<string, unknown>)
      .superdshFrontendIndexVersion !== 1
  ) {
    throw new Error(
      'SuperDsh requires the patched Harness static frontend entry (version 1)',
    )
  }
  const preferences = parsePreferences(
    JSON.parse(process.env.DSH_NEXT_PREFERENCES ?? '{}'),
  )
  const trustedHosts = JSON.parse(
    process.env.DSH_NEXT_TRUSTED_HOSTS ?? '[]',
  ) as unknown
  if (
    !Array.isArray(trustedHosts) ||
    trustedHosts.some((host) => typeof host !== 'string')
  )
    throw new Error('Invalid Next trusted hosts')
  const systemProxy = parseSystemProxyProbe(process.env[SYSTEM_PROXY_ENV])
  configureNextBrowserAccess(
    process.env.DSH_NEXT_NATIVE_TOKEN,
    preferences.browserAccess,
  )
  delete process.env.DSH_NEXT_NATIVE_TOKEN
  delete process.env.DSH_NEXT_PREFERENCES
  delete process.env.DSH_NEXT_TRUSTED_HOSTS
  delete process.env[SYSTEM_PROXY_ENV]
  // The bootstrap and the Loader must resolve the same app-boot/Cordis instances.
  // Anchoring at the Electron package would select its separate Yarn installation
  // after runProfile was already imported from this adapter and lose app-boot's
  // root Include WeakMap during live plugin changes.
  const installAnchor = NEXT_PACKAGE
  const profile = loadNextProfile(
    projectDir,
    home,
    installAnchor,
    join(runtimeDir, 'package.json'),
  )
  const runtimePatch = join(projectDir, 'desktop-next.runtime.patch.json')
  atomicJson(runtimePatch, [
    ...(process.env.SUPERDSH_PLATFORM_MANAGED === '1'
      ? [
          { id: 'agents-anywhere-bridge-next', disabled: true },
          {
            insert: [
              {
                id: 'superdsh-managed-bridge',
                name: '@superdsh/harness/managed-bridge',
                config: {
                  dshHome: home,
                  stateRoot: join(home, 'platform-connector'),
                },
              },
              {
                id: 'superdsh-managed-models',
                name: '@superdsh/harness/managed-models',
              },
            ],
          },
        ]
      : []),
    {
      id: 'desktop-next-webserver',
      config: { host: '127.0.0.1', port: preferences.port },
    },
    { id: 'connection', config: { trustedHosts } },
    ...frontendRuntimePatch(
      process.env.SUPERDSH_CLIENT_MANIFEST,
      trustedHosts as string[],
    ),
  ])
  // runProfile installs the outbound proxy policy from this environment before any plugin mounts.
  const { environment, resolution: proxy } = withSystemProxy(
    loadLayeredEnv('dsh-desktop-next'),
    systemProxy,
    trustedHosts as string[],
  )
  // One line on every start, direct included: a connectivity report cannot be answered without it.
  for (const line of [proxy.summary, ...proxy.diagnostics])
    process.stderr.write(`dsh-desktop-next: ${maskSecrets(line)}\n`)
  const application = startHarnessHost({
    environment,
    profile: basename(projectDir),
    resolvedProfile: { profile, installAnchor },
    patchFiles: [
      join(dirname(NEXT_PACKAGE), 'host.cordis.patch.yml'),
      join(projectDir, 'desktop-next.cordis.patch.json'),
      runtimePatch,
    ],
    args: ['--no-open', '--port', String(preferences.port)],
    packageManager: {
      command: process.execPath,
      args: [
        '--expose-internals',
        bundledPnpmEntry(NEXT_PACKAGE),
        ...withDesktopPnpmPolicy([]),
      ],
      env: {
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        SUPERDSH_DESKTOP_PACKAGE: installAnchor,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        PATH: `${join(runtimeDir, 'scripts', 'node-bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
  const send = (value: object): Promise<void> =>
    new Promise((resolveSend, reject) => {
      if (!process.connected || !process.send) return resolveSend()
      process.send(value, (error) => (error ? reject(error) : resolveSend()))
    })
  let stopping: Promise<void> | undefined
  const accountWatch = new AbortController()
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      accountWatch.abort()
      const running = await application.catch(() => undefined)
      await running?.shutdown(0)
      await send({ type: 'shutdown-complete' })
      if (process.connected) process.disconnect()
    })())
  process.on('message', (value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      (value.type === 'platform-tasks' || value.type === 'platform-models')
    ) {
      const request = value as {
        type: string
        requestId?: unknown
        action?: unknown
      }
      if (
        !Number.isSafeInteger(request.requestId) ||
        (request.type === 'platform-tasks' &&
          request.action !== 'inspect' &&
          request.action !== 'stop')
      )
        return
      void application
        .then(async ({ ctx }) => {
          if (stopping) throw new Error('Next Host is stopping')
          if (request.type === 'platform-models') {
            await refreshPlatformModels(ctx)
            await send({ type: request.type, requestId: request.requestId })
          } else {
            const active = await (request.action === 'inspect'
              ? inspectPlatformTasks(ctx)
              : stopPlatformTasks(ctx))
            await send({
              type: request.type,
              requestId: request.requestId,
              active,
            })
          }
        })
        .catch(async (error: unknown) => {
          await send({
            type: request.type,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : '平台状态更新失败',
          })
        })
        .catch(fatal)
      return
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'shutdown'
    )
      void stop().catch(fatal)
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'injections'
    ) {
      // dsh 0.1.7 serves the boot graph as revision-addressed combo bundles, and registering a
      // plugin rebuilds that table. A document reloading against the table captured at startup
      // would request bundles the Web server no longer publishes, so the answer is collected now.
      const query = value as { requestId?: unknown }
      if (!Number.isSafeInteger(query.requestId)) return
      void application
        .then(async ({ ctx }) => {
          if (stopping) throw new Error('Next Host is stopping')
          await send({
            type: 'injections',
            requestId: query.requestId,
            injections: ctx.webServer.collectIndexInjections(),
          })
        })
        .catch(async () => {
          await send({
            type: 'injections',
            requestId: query.requestId,
            error: 'Could not collect Web boot injections',
          })
        })
        .catch(fatal)
      return
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'browser-access'
    )
      return
    const request = value as { requestId?: unknown; enabled?: unknown }
    if (
      !Number.isSafeInteger(request.requestId) ||
      typeof request.enabled !== 'boolean'
    )
      return
    const enabled = request.enabled
    void application
      .then(async ({ ctx }) => {
        if (stopping) throw new Error('Next Host is stopping')
        ;(ctx.webServer as NextWebServer).setBrowserAccess(enabled)
        await send({ type: 'browser-access', requestId: request.requestId })
      })
      .catch(async () => {
        await send({
          type: 'browser-access',
          requestId: request.requestId,
          error: 'Could not update browser access',
        })
      })
      .catch(fatal)
  })
  process.once('disconnect', () => {
    void stop().catch(fatal)
  })
  const { ctx } = await application
  await send({
    type: 'ready',
    url: ctx.connection.authenticatedUrl(
      `http://127.0.0.1:${ctx.webServer.port}`,
    ),
    injections: ctx.webServer.collectIndexInjections(),
  })
  const account = ctx.get('deepseekAccount') as PlatformLoginAccount | undefined
  if (account !== undefined && !stopping) {
    // A broken watcher only loses the automatic browser hand-off; the dialog still offers the link.
    void watchPlatformLogin(
      account,
      (request) => {
        void send({ type: 'platform-login', ...request }).catch(() => {})
      },
      accountWatch.signal,
    ).catch((error: unknown) => {
      if (!accountWatch.signal.aborted)
        console.error(
          '[dsh-desktop-next] platform login watcher stopped',
          error,
        )
    })
  }
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

export function fatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // The shell receives the complete inspected error here, not through stderr:
  // stderr bytes and this IPC message race, and the shell reports the first
  // failure it sees.
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(
    0,
    MAX_FATAL_DIAGNOSTIC_CHARS,
  )
  if (process.connected)
    process.send?.({ type: 'fatal', message, diagnostic }, () => {
      if (process.connected) process.disconnect()
    })
  console.error(error)
  process.exitCode = 1
}
