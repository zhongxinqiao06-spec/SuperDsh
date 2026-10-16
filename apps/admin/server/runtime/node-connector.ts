import { createHash, randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError, object } from '../http/api-router.ts'
import { HarnessBridgeClient } from './bridge-client.ts'
import type { RuntimeNotification } from './bridge-client.ts'
import { BridgeSync } from './bridge-sync.ts'
import { bridgeCatalog, bridgeCatalogNotification } from './bridge-catalogs.ts'

export interface DownloadedAttachment {
  content: Buffer
  mediaType: string
  name?: string
}
export interface NodeConnectorOptions {
  prepareBusiness?(sessionId: string): Promise<string | undefined>
  connectorId: string
  home: string
  workspace: string
  stateDirectory: string
  ingest(events: RuntimeNotification[]): Promise<void>
  health(status: 'starting' | 'running' | 'error'): Promise<void>
  disconnected(): void
  attachment?(sessionId: string, fileId: string): Promise<DownloadedAttachment>
  platformCall?(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
}
export class NodeHarnessConnector {
  private readonly options: NodeConnectorOptions
  private readonly bridge: HarnessBridgeClient
  private readonly sync: BridgeSync
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  readonly ready: Promise<void>
  private initial: Record<string, unknown> = {}
  private agentPresets: Record<string, unknown> = {}
  private defaultAgentPreset: string | undefined
  private shuttingDown = false
  constructor(options: NodeConnectorOptions) {
    this.options = options
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    void this.ready.catch(() => {})
    this.bridge = new HarnessBridgeClient({
      notification: (event) => this.notification(event),
      disconnected: () => {
        this.readyReject(new Error('Harness disconnected'))
        if (!this.shuttingDown) options.disconnected()
      },
    })
    this.sync = new BridgeSync({
      client: this.bridge,
      directory: join(options.stateDirectory, 'checkpoints'),
      ingest: (events) => this.publish(events),
      healthy: async () => {
        await options.health('running')
        this.readyResolve()
      },
      failed: () => {
        this.readyReject(new Error('Harness synchronization failed'))
        if (!this.shuttingDown) options.disconnected()
      },
    })
  }
  async start(signal: AbortSignal): Promise<void> {
    await this.options.health('starting')
    this.initial = await this.bridge.start(
      this.options.home,
      this.options.connectorId,
      signal,
    )
    if (object(this.initial.features ?? {}).syncMode !== 'events')
      throw new Error('Pinned Harness requires projection event sync')
    this.agentPresets = object(
      await this.bridge.request('catalog.listAgentPresets', {}, signal),
    )
    const declaredDefault = object(this.agentPresets.configField ?? {}).default
    if (typeof declaredDefault === 'string')
      this.defaultAgentPreset = declaredDefault
    const capability = object(
      await this.bridge.request('runtime.getCapabilities', {}, signal),
    )
    await this.publish([
      { method: 'runtime.capability.updated', params: capability },
    ])
    for (const [method, notification] of [
      ['catalog.listModels', 'catalog.model.update'],
      ['catalog.listPermissions', 'catalog.permission.update'],
    ] as const) {
      try {
        await this.publish([
          {
            method: notification,
            params: object(
              await this.bridge.request(method, { limit: 10000 }, signal),
            ),
          },
        ])
      } catch {
        /* Unconfigured model catalog must not prevent local history synchronization. */
      }
    }
    await this.sync.start()
  }
  async close(): Promise<void> {
    this.shuttingDown = true
    this.bridge.close()
    await this.sync.stop()
    this.readyReject(new Error('Connector stopped'))
  }
  private publish(events: RuntimeNotification[]): Promise<void> {
    return this.options.ingest(
      events.map(bridgeCatalogNotification).map((event) => ({
        ...event,
        params: { ...event.params, runtime: 'dsh', runtimeId: 'dsh' },
      })),
    )
  }
  private notification(event: RuntimeNotification): void {
    if (event.method === 'runtime.sync.batch') this.sync.accept(event.params)
    else if (event.method === 'runtime.capabilities.update')
      void this.publish([
        { method: 'runtime.capability.updated', params: event.params },
      ]).catch(() => this.options.disconnected())
    else if (event.method === 'runtime.error')
      void this.sync.start().catch(() => this.options.disconnected())
  }
  async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      (params.runtimeId !== undefined && params.runtimeId !== 'dsh') ||
      (params.runtime !== undefined && params.runtime !== 'dsh')
    )
      throw new ApiError(
        422,
        'Server Agent supports its owned DSH runtime only',
      )
    const scope = { runtime: 'dsh', runtimeId: 'dsh' }
    const request = async (name: string, payload = params) =>
      object(await this.bridge.request(name, payload, signal))
    if (method === 'runtime.discover')
      return {
        runtimeTypes: [
          {
            runtimeType: 'dsh',
            implementationType: 'dsh',
            displayName: 'DeepSeek Harness',
            available: true,
            present: true,
            recommended: true,
            instancePolicy: 'singleton',
            maxInstances: 1,
            defaults: {},
            capabilities: {},
            metadata: {},
          },
        ],
      }
    if (method === 'runtime.configSchema')
      return {
        ...scope,
        configSchema: {
          type: 'object',
          properties: {
            defaultAgentPreset: this.agentPresets.configField ?? {
              type: 'string',
            },
          },
          additionalProperties: false,
        },
      }
    if (method === 'runtime.config')
      return {
        ...scope,
        running: this.bridge.connected,
        config: {
          values: {
            dshHome: this.options.home,
            defaultAgentPreset: this.defaultAgentPreset,
          },
        },
      }
    if (method === 'runtime.validateConfig' || method === 'runtime.start') {
      const config = object(params.config ?? params.values ?? {})
      const values = object(config.values ?? config)
      if (values.dshHome !== undefined && values.dshHome !== this.options.home)
        throw new ApiError(422, 'Server Agent Home is product-owned')
      if (values.defaultAgentPreset !== undefined) {
        const presets = Array.isArray(this.agentPresets.presets)
          ? this.agentPresets.presets
          : []
        if (
          typeof values.defaultAgentPreset !== 'string' ||
          !presets.some(
            (item) =>
              object(item).id === values.defaultAgentPreset &&
              object(item).enabled !== false,
          )
        )
          throw new ApiError(422, 'unknown or unavailable Agent mode')
        if (method === 'runtime.start')
          this.defaultAgentPreset = values.defaultAgentPreset
      }
      return {
        ...scope,
        valid: true,
        status: this.bridge.connected ? 'running' : 'error',
      }
    }
    if (method === 'runtime.stop')
      throw new ApiError(
        409,
        'Server Agent lifecycle is managed by the platform',
      )
    if (method === 'runtime.capabilities')
      return {
        ...scope,
        capabilitySet: await request('runtime.getCapabilities'),
      }
    if (method === 'runtime.modelCatalog')
      return {
        ...scope,
        catalog: bridgeCatalog('model', await request('catalog.listModels')),
      }
    if (method === 'runtime.permissionCatalog')
      return {
        ...scope,
        catalog: bridgeCatalog(
          'permission',
          await request('catalog.listPermissions'),
        ),
      }
    if (method === 'session.discover')
      return { ...scope, ...(await request('session.list')) }
    if (method === 'session.state') {
      const state = await request('session.getState')
      const events: RuntimeNotification[] = [
        { method: 'session.state.updated', params: state },
      ]
      if (state.sourceState && typeof state.sourceState === 'object')
        events.push({
          method: 'session.source.updated',
          params: {
            sessionId: params.sessionId,
            externalSessionId: state.externalSessionId,
            ...object(state.sourceState),
            observationOrigin: 'operation',
          },
        })
      await this.publish(events)
      return { ...scope, state }
    }
    if (method === 'session.capabilities')
      return {
        ...scope,
        capabilitySet: await request('session.getCapabilities'),
      }
    if (method === 'session.notices')
      return { ...scope, ...(await request('session.getNotices')) }
    if (method === 'session.sync') {
      await request('runtime.sync.refresh')
      return {
        ...scope,
        accepted: true,
        background: true,
        sessionId: params.sessionId,
        externalSessionId: params.externalSessionId,
      }
    }
    if (method === 'session.create' || method === 'session.send_message') {
      if (typeof params.clientMessageId !== 'string' || !params.clientMessageId)
        throw new ApiError(422, 'stable clientMessageId required')
      const options = object(params.runtimeOptions ?? {})
      if (Object.keys(options).some((key) => key !== 'agentPreset'))
        throw new ApiError(422, 'unsupported Harness creation option')
      const staged = await this.attachments(params)
      try {
        const businessPreset = this.options.prepareBusiness
          ? await this.options.prepareBusiness(String(params.sessionId))
          : undefined
        if (
          typeof options.agentPreset === 'string' &&
          options.agentPreset.startsWith('business-')
        )
          throw new ApiError(422, '业务智能体必须通过产品入口选择')
        // A server session always starts in the owned workspace. Existing session
        // operations keep their native identity; client-supplied host paths cannot select a new workspace.
        if (params.cwd && params.cwd !== this.options.workspace)
          throw new ApiError(422, 'Server Agent workspace is product-owned')
        const result = await request(
          method === 'session.create'
            ? 'session.createAndStart'
            : 'session.startTurn',
          {
            ...params,
            cwd: this.options.workspace,
            ...(method === 'session.create'
              ? {
                  agentPreset:
                    businessPreset ??
                    options.agentPreset ??
                    this.defaultAgentPreset,
                }
              : {}),
            ...(staged.values.length ? { attachments: staged.values } : {}),
          },
        )
        return {
          ...scope,
          ok: result.ok !== false,
          code: result.code,
          message: result.message,
          result: result.ok === false ? (result.result ?? {}) : result,
        }
      } finally {
        await staged.close()
      }
    }
    if (method === 'session.selections.update')
      return { ...scope, ...(await request('session.updateSelections')) }
    if (method === 'interaction.respond')
      return { ...scope, ...(await request('session.respondInteraction')) }
    if (method === 'session.interrupt')
      return { ...scope, ok: true, result: await request('session.interrupt') }
    // These controls remain unsupported by the pinned full Host bridge, just as in its Python adapter.
    if (['session.commands', 'runtime.commands'].includes(method))
      return { ...scope, commands: [] }
    if (['session.steer', 'session.command.execute'].includes(method))
      throw new ApiError(
        501,
        'operation is not supported by this Harness runtime',
      )
    if (this.options.platformCall)
      return this.options.platformCall(method, params, signal)
    throw new ApiError(501, 'unsupported Connector operation')
  }
  private async attachments(
    params: Record<string, unknown>,
  ): Promise<{ values: Record<string, unknown>[]; close(): Promise<void> }> {
    const raw = params.attachments ?? []
    if (!Array.isArray(raw)) throw new ApiError(422, 'invalid attachments')
    const values: Record<string, unknown>[] = []
    const paths: string[] = []
    const seen = new Set<string>()
    const close = async () => {
      await Promise.all(
        paths.map((path) =>
          unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          }),
        ),
      )
    }
    try {
      for (const entry of raw) {
        const item = object(entry)
        if (
          typeof item.fileId !== 'string' ||
          !/^file_[\w-]{1,128}$/.test(item.fileId) ||
          seen.has(item.fileId) ||
          !this.options.attachment ||
          typeof params.sessionId !== 'string'
        )
          throw new ApiError(422, 'invalid or unavailable attachment')
        seen.add(item.fileId)
        const downloaded = await this.options.attachment(
          params.sessionId,
          item.fileId,
        )
        const hash = createHash('sha256')
          .update(downloaded.content)
          .digest('hex')
        const mediaType = downloaded.mediaType
          .split(';')[0]!
          .trim()
          .toLowerCase()
        if (
          mediaType !== item.mediaType ||
          (item.size !== undefined &&
            item.size !== downloaded.content.length) ||
          (item.sha256 && item.sha256 !== hash)
        )
          throw new ApiError(422, 'attachment does not match its upload')
        const directory = join(
          this.options.home,
          'agents-anywhere',
          'bridge',
          'attachments',
          'staging',
        )
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const uploadId = randomBytes(16).toString('hex')
        const path = join(directory, uploadId)
        await writeFile(path, downloaded.content, { flag: 'wx', mode: 0o600 })
        paths.push(path)
        values.push({
          uploadId,
          fileId: item.fileId,
          name: item.name ?? downloaded.name ?? item.fileId,
          mediaType,
          size: downloaded.content.length,
          sha256: hash,
        })
      }
      return { values, close }
    } catch (error) {
      await close()
      throw error
    }
  }
}
