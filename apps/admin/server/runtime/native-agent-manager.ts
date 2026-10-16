/** Product data separation only: native processes are not an OS security boundary. */
import { createHash } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type NativeAgentPhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'unavailable'
  | 'stopping'
  | 'stopped'
  | 'error'

export interface NativeAgentSnapshot {
  userId: string
  phase: NativeAgentPhase
  code: string | null
  message: string | null
}

export interface NativeAgentPaths {
  directory: string
  home: string
  workspace: string
  connector: string
  credentials: string
  temporary: string
}

export interface NativeAgentStartContext {
  userId: string
  paths: Readonly<NativeAgentPaths>
  signal: AbortSignal
  /** Product-selected command. Request parameters never select a program or arguments. */
  host: {
    executable: string
    args: readonly string[]
    cwd: string
    environment: Readonly<NodeJS.ProcessEnv>
  }
}

export interface NativeAgentReadiness {
  hostReady: boolean
  connectorReady: boolean
}

export interface NativeAgentExit {
  code: number | null
  signal: string | null
}

export interface NativeAgentInstance {
  /** Must reflect the real Host and authenticated Connector, not process creation. */
  ready: Promise<NativeAgentReadiness>
  /** Resolve only when the entire owned process tree exits, not just its Host parent. */
  exited: Promise<NativeAgentExit>
  /** Resolve only after the worker, Host and their owned children have exited. */
  stop(): Promise<void>
}

export interface NativeAgentAdapter {
  /** On rejection, clean up any processes already created; respect context.signal. */
  start(context: NativeAgentStartContext): Promise<NativeAgentInstance>
}

interface Entry {
  snapshot: NativeAgentSnapshot
  controller: AbortController
  instance?: NativeAgentInstance
  operation?: Promise<NativeAgentSnapshot>
  stopping?: Promise<NativeAgentSnapshot>
  instanceStop?: Promise<void>
  startingResources?: boolean
}

const hostEntry = fileURLToPath(new URL('./host.mjs', import.meta.url))
const systemEnvironment = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
])

function identity(userId: string): string {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 200)
    throw new Error('A stable user ID is required')
  return userId
}

/** Do not inherit API/database credentials, NODE_OPTIONS, or a user's shell profile. */
export function nativeAgentEnvironment(
  paths: NativeAgentPaths,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
  for (const [name, value] of Object.entries(source)) {
    if (systemEnvironment.has(name.toUpperCase()) && value !== undefined)
      result[name] = value
  }
  return {
    ...result,
    NODE_ENV: 'production',
    DSH_HOME: paths.home,
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    XDG_CACHE_HOME: join(paths.home, '.cache'),
    XDG_DATA_HOME: join(paths.home, '.local', 'share'),
    AGENT_CONNECTOR_DATA_DIR: paths.connector,
    SUPERDSH_AGENT_WORKSPACE: paths.workspace,
    TEMP: paths.temporary,
    TMP: paths.temporary,
    TMPDIR: paths.temporary,
  }
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('Agent directories must be real directories')
}

export class NativeAgentManager {
  private readonly rootDirectory: string
  private readonly adapter: NativeAgentAdapter
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly entries = new Map<string, Entry>()
  private closed = false
  private closing?: Promise<void>

  constructor(options: {
    rootDirectory: string
    adapter: NativeAgentAdapter
    startupTimeoutMs?: number
    shutdownTimeoutMs?: number
  }) {
    if (!isAbsolute(options.rootDirectory))
      throw new Error(
        'Agent root directory must be an absolute server-owned path',
      )
    if (!options.adapter || typeof options.adapter.start !== 'function')
      throw new Error('A complete native Agent adapter is required')
    this.rootDirectory = resolve(options.rootDirectory)
    this.adapter = options.adapter
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000
    if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs <= 0)
      throw new Error('Agent startup timeout must be positive')
    if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0)
      throw new Error('Agent shutdown timeout must be positive')
  }

  status(userId: string): NativeAgentSnapshot {
    identity(userId)
    return {
      ...(this.entries.get(userId)?.snapshot ?? {
        userId,
        phase: 'idle',
        code: null,
        message: null,
      }),
    }
  }

  prepare(userId: string): Promise<NativeAgentSnapshot> {
    identity(userId)
    if (this.closed) return Promise.reject(new Error('Agent manager is closed'))
    const previous = this.entries.get(userId)
    if (previous?.stopping)
      return previous.stopping.then(() => this.prepare(userId))
    if (previous?.operation) return previous.operation
    if (
      previous?.snapshot.phase === 'ready' ||
      previous?.instance ||
      previous?.startingResources
    )
      return Promise.resolve(this.status(userId))
    const entry: Entry = {
      snapshot: { userId, phase: 'starting', code: null, message: null },
      controller: new AbortController(),
    }
    this.entries.set(userId, entry)
    entry.operation = this.launch(entry).finally(() => {
      entry.operation = undefined
    })
    return entry.operation
  }

  stop(userId: string): Promise<NativeAgentSnapshot> {
    identity(userId)
    const entry = this.entries.get(userId)
    if (!entry) return Promise.resolve(this.status(userId))
    if (entry.stopping) return entry.stopping
    this.set(entry, 'stopping')
    entry.controller.abort()
    entry.stopping = (async () => {
      await entry.operation
      try {
        if (entry.startingResources) {
          this.set(
            entry,
            'error',
            'startup-unresolved',
            'Agent startup cancellation is not yet confirmed',
          )
          return this.status(userId)
        }
        await this.stopInstance(entry)
        this.set(entry, 'stopped')
      } catch {
        this.set(entry, 'error', 'shutdown-failed', 'Agent shutdown failed')
      }
      return this.status(userId)
    })().finally(() => {
      entry.stopping = undefined
    })
    return entry.stopping
  }

  close(): Promise<void> {
    this.closed = true
    this.closing ??= (async () => {
      const results = await Promise.all(
        [...this.entries.keys()].map((userId) => this.stop(userId)),
      )
      if (
        results.some(
          (result) =>
            result.code === 'shutdown-failed' ||
            result.code === 'startup-unresolved',
        )
      )
        throw new Error('Some native Agent processes could not be stopped')
    })()
    return this.closing
  }

  private set(
    entry: Entry,
    phase: NativeAgentPhase,
    code: string | null = null,
    message: string | null = null,
  ): void {
    entry.snapshot = { userId: entry.snapshot.userId, phase, code, message }
  }

  private async paths(userId: string): Promise<NativeAgentPaths> {
    await ownedDirectory(this.rootDirectory)
    const directory = join(
      this.rootDirectory,
      createHash('sha256').update(userId).digest('hex'),
    )
    await ownedDirectory(directory)
    const paths = {
      directory,
      home: join(directory, 'home'),
      workspace: join(directory, 'workspace'),
      connector: join(directory, 'connector'),
      credentials: join(directory, 'credentials'),
      temporary: join(directory, 'tmp'),
    }
    for (const path of Object.values(paths)) await ownedDirectory(path)
    return paths
  }

  private async launch(entry: Entry): Promise<NativeAgentSnapshot> {
    const signal = entry.controller.signal
    const timeout = setTimeout(
      () => entry.controller.abort(),
      this.startupTimeoutMs,
    )
    try {
      const paths = await this.paths(entry.snapshot.userId)
      signal.throwIfAborted()
      const context: NativeAgentStartContext = {
        userId: entry.snapshot.userId,
        paths: Object.freeze(paths),
        signal,
        host: {
          executable: process.execPath,
          args: Object.freeze([hostEntry]),
          cwd: paths.workspace,
          environment: Object.freeze(nativeAgentEnvironment(paths)),
        },
      }
      entry.startingResources = true
      const starting = Promise.resolve()
        .then(() => this.adapter.start(context))
        .then(
          async (instance) => {
            entry.startingResources = false
            entry.instance = instance
            const exited = this.observeInstance(entry, instance)
            if (signal.aborted) {
              try {
                await this.stopInstance(entry)
                if (entry.snapshot.code === 'startup-unresolved')
                  this.set(entry, 'stopped')
              } catch {
                this.set(
                  entry,
                  'error',
                  'shutdown-failed',
                  'Agent shutdown failed',
                )
              }
            }
            return { instance, exited }
          },
          (error: unknown) => {
            entry.startingResources = false
            if (entry.snapshot.code === 'startup-unresolved')
              this.set(entry, 'stopped')
            throw error
          },
        )
      // Keep ownership of a non-cooperative late adapter, but do not block prepare/close.
      void starting.catch(() => {})
      const { instance, exited } = await this.withCancellation(starting, signal)
      // A terminated process must never be promoted to ready by a delayed handshake.
      const readiness = await this.waitReady(instance.ready, exited, signal)
      signal.throwIfAborted()
      if (!entry.instance) throw new Error('Agent exited before readiness')
      if (!readiness.hostReady || !readiness.connectorReady) {
        await this.stopInstance(entry)
        this.set(
          entry,
          'unavailable',
          readiness.hostReady ? 'connector-not-ready' : 'host-not-ready',
          readiness.hostReady
            ? 'Harness is ready but its authenticated Connector is not ready'
            : 'Harness is not ready',
        )
      } else this.set(entry, 'ready')
    } catch {
      // Adapter diagnostics can contain endpoint credentials; never expose raw errors.
      try {
        await this.stopInstance(entry)
        if (entry.snapshot.phase !== 'stopping' && entry.snapshot.code === null)
          this.set(entry, 'error', 'startup-failed', 'Agent startup failed')
      } catch {
        this.set(entry, 'error', 'shutdown-failed', 'Agent shutdown failed')
      }
    } finally {
      clearTimeout(timeout)
    }
    return this.status(entry.snapshot.userId)
  }

  private onExit(entry: Entry): void {
    entry.instance = undefined
    if (
      !entry.controller.signal.aborted &&
      (entry.snapshot.phase === 'starting' || entry.snapshot.phase === 'ready')
    )
      this.set(entry, 'error', 'process-exited', 'Agent process exited')
    // No restart or task replay. Only an explicit prepare may start another instance.
  }

  private observeInstance(
    entry: Entry,
    instance: NativeAgentInstance,
  ): Promise<void> {
    // Observe late handshake failures even after cancellation won the startup race.
    void instance.ready.catch(() => {})
    const exited = instance.exited.then(
      () => this.onExit(entry),
      async () => {
        // A failed monitor is not evidence of process-tree exit.
        try {
          await this.stopInstance(entry)
        } catch {
          this.set(entry, 'error', 'shutdown-failed', 'Agent shutdown failed')
        }
        throw new Error('Agent process monitor failed')
      },
    )
    void exited.catch(() => {})
    return exited
  }

  private async stopInstance(entry: Entry): Promise<void> {
    const instance = entry.instance
    if (!instance) return
    if (!entry.instanceStop) {
      const stopping = Promise.resolve().then(async () => {
        await instance.stop()
        await instance.exited
        if (entry.instance === instance) entry.instance = undefined
      })
      entry.instanceStop = stopping
      void stopping
        .finally(() => {
          if (entry.instanceStop === stopping) entry.instanceStop = undefined
        })
        .catch(() => {})
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.shutdownTimeoutMs)
    try {
      await this.withCancellation(entry.instanceStop, controller.signal)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async waitReady(
    ready: Promise<NativeAgentReadiness>,
    exited: Promise<void>,
    signal: AbortSignal,
  ): Promise<NativeAgentReadiness> {
    return this.withCancellation(
      Promise.race([
        ready,
        exited.then(() => {
          throw new Error('Agent exited before readiness')
        }),
      ]),
      signal,
    )
  }

  private async withCancellation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted()
    let abort: () => void = () => {}
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('Agent startup cancelled'))
          signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
