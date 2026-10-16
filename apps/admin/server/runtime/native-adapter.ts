import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ModelGateway } from './model-gateway.ts'
import { NodeHarnessConnector } from './node-connector.ts'
import type { DownloadedAttachment } from './node-connector.ts'
import type {
  NativeAgentAdapter,
  NativeAgentExit,
  NativeAgentStartContext,
  NativeAgentInstance,
} from './native-agent-manager.ts'
import type { ModelProxy } from '../models/model-routes.ts'
import type { RuntimeNotification } from './bridge-client.ts'
import { BusinessHostChannel } from '../agents/host-channel.ts'
import type { BusinessAgentPort } from '../agents/contracts.ts'

export interface NativeBinding {
  connectorId: string
  credentialFingerprint: string
}
export interface NativeAdapterOptions {
  business?: BusinessAgentPort
  proxy: ModelProxy
  binding(userId: string): Promise<NativeBinding>
  register(
    connectorId: string,
    connector: {
      call(
        method: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<unknown>
      close(): Promise<void>
    },
  ): Promise<() => Promise<void>>
  ingest(connectorId: string, events: RuntimeNotification[]): Promise<void>
  health(
    connectorId: string,
    status: 'starting' | 'running' | 'error',
  ): Promise<void>
  attachment?(
    connectorId: string,
    sessionId: string,
    fileId: string,
  ): Promise<DownloadedAttachment>
  platform?(
    userId: string,
    workspace: string,
    context: { connectorId: string; environment: Readonly<NodeJS.ProcessEnv> },
  ): {
    call(
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown>
    close(): Promise<void>
  }
}

async function killTree(child: ChildProcess, force: boolean): Promise<void> {
  if (!child.pid || child.pid <= 0) return
  if (process.platform === 'win32') {
    // The pid comes only from this adapter's own ChildProcess, never user input.
    await new Promise<void>((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
        { windowsHide: true, stdio: 'ignore' },
      )
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

/** Parent owns the loopback connector and gateway; only the full Host runs as a child. */
export class NativeHarnessAdapter implements NativeAgentAdapter {
  readonly options: NativeAdapterOptions
  private readonly children = new Map<string, ChildProcess>()
  constructor(options: NativeAdapterOptions) {
    this.options = options
  }
  refreshModels(owner: string | null): void {
    for (const [user, child] of this.children)
      if ((!owner || owner === user) && child.connected)
        child.send({ type: 'refresh-models' }, () => {})
  }
  async start(context: NativeAgentStartContext): Promise<NativeAgentInstance> {
    const binding = await this.options.binding(context.userId)
    context.signal.throwIfAborted()
    const gateway = new ModelGateway({
      proxy: this.options.proxy,
      owner: context.userId,
      connector: binding.connectorId,
      fingerprint: binding.credentialFingerprint,
    })
    const origin = await gateway.start()
    let child: ChildProcess | undefined
    let connector: NodeHarnessConnector | undefined
    let business: BusinessHostChannel | undefined
    let unregister: (() => Promise<void>) | undefined
    let stopped = false
    let stopping: Promise<void> | undefined
    const platform = this.options.platform?.(
      context.userId,
      context.paths.workspace,
      {
        connectorId: binding.connectorId,
        environment: context.host.environment,
      },
    )
    let resolveExited!: (value: NativeAgentExit) => void
    const exited = new Promise<NativeAgentExit>((resolve) => {
      resolveExited = resolve
    })
    let resolveChild!: (value: NativeAgentExit) => void
    const childExited = new Promise<NativeAgentExit>((resolve) => {
      resolveChild = resolve
    })
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        stopped = true
        this.children.delete(context.userId)
        context.signal.removeEventListener('abort', abort)
        await connector?.close()
        business?.close()
        await unregister?.()
        await platform?.close()
        await gateway.close()
        if (child) {
          if (child.connected) child.send({ type: 'shutdown' }, () => {})
          else await killTree(child, false)
          let timer: NodeJS.Timeout | undefined
          const grace = await Promise.race([
            childExited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 5000)
            }),
          ])
          clearTimeout(timer)
          if (!grace) await killTree(child, true)
          // A clean parent exit does not prove all child tools exited. Reap its
          // process group on POSIX; Windows /T must run before the parent exits.
          if (process.platform !== 'win32') await killTree(child, true)
          const result = await childExited
          resolveExited(result)
        } else resolveExited({ code: null, signal: null })
      })()
      return stopping
    }
    const abort = () => {
      void stop()
    }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      context.signal.throwIfAborted()
      let readyResolve!: () => void
      let readyReject!: (error: unknown) => void
      const hostReady = new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      })
      void hostReady.catch(() => {})
      child = spawn(context.host.executable, [...context.host.args], {
        cwd: context.host.cwd,
        env: {
          ...context.host.environment,
          SUPERDSH_MODEL_GATEWAY: JSON.stringify({
            origin,
            secret: gateway.secret,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      child.stdout?.resume()
      child.stderr?.resume()
      if (this.options.business)
        business = new BusinessHostChannel(
          child,
          context.userId,
          this.options.business,
        )
      this.children.set(context.userId, child)
      child.once('error', () => {
        readyReject(new Error('Harness process could not start'))
        resolveChild({ code: null, signal: null })
        void stop()
      })
      child.once('exit', (code, signal) => {
        readyReject(new Error('Harness process exited before readiness'))
        resolveChild({ code, signal })
        if (!stopped) void stop()
      })
      child.on('message', (value: unknown) => {
        if (!value || typeof value !== 'object') return
        const message = value as Record<string, unknown>
        if (message.type === 'host-ready') readyResolve()
        if (message.type === 'host-error')
          readyReject(new Error('Harness startup failed'))
      })
      const ready = (async () => {
        await hostReady
        if (business && this.options.business)
          for (const binding of await this.options.business.bindings(
            context.userId,
          ))
            await business.install(binding)
        context.signal.throwIfAborted()
        connector = new NodeHarnessConnector({
          connectorId: binding.connectorId,
          home: context.paths.home,
          workspace: context.paths.workspace,
          stateDirectory: context.paths.connector,
          prepareBusiness: business
            ? (session) => business!.prepare(session)
            : undefined,
          ingest: (events) => this.options.ingest(binding.connectorId, events),
          health: (status) => this.options.health(binding.connectorId, status),
          disconnected: () => {
            void stop()
          },
          attachment: this.options.attachment
            ? (session, file) =>
                this.options.attachment!(binding.connectorId, session, file)
            : undefined,
          platformCall: platform
            ? (method, params, signal) => platform.call(method, params, signal)
            : undefined,
        })
        unregister = await this.options.register(binding.connectorId, {
          call: (method, params, signal) =>
            connector!.call(method, params, signal),
          close: async () => {
            await connector?.close()
            if (!stopped) void stop()
          },
        })
        await connector.start(context.signal)
        await connector.ready
        context.signal.throwIfAborted()
        if (stopped) throw new Error('Harness stopped before readiness')
        return { hostReady: true, connectorReady: true }
      })()
      void ready.catch(() => stop())
      return { ready, exited, stop }
    } catch (error) {
      await stop()
      throw error
    }
  }
}
