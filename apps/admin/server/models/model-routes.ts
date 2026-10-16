import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError, bearer, requiredText, utcNow } from '../http/api-router.ts'
import type { Account, ApiContext, ApiRouter } from '../http/api-router.ts'
import { ModelService } from './model-service.ts'
import { providerRequest } from './provider-http.ts'
import type { AddressResolver } from './provider-http.ts'

export interface ModelPrincipal {
  id: string
  userId: string
  tokenHash?: string
}
export interface ModelAuthorization {
  authenticateConnector(token: string): Promise<ModelPrincipal | null>
  connectorAllowed(
    id: string,
    ownerId: string,
    credentialFingerprint?: string,
  ): Promise<boolean>
  getAccount(id: string): Promise<Account | null>
}
export class ModelProxy {
  readonly models: ModelService
  readonly auth: ModelAuthorization
  readonly allowedOrigins: string
  readonly resolver?: AddressResolver
  constructor(options: {
    models: ModelService
    auth: ModelAuthorization
    allowedOrigins?: string
    resolver?: AddressResolver
  }) {
    this.models = options.models
    this.auth = options.auth
    this.allowedOrigins =
      options.allowedOrigins ??
      process.env.SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS ??
      ''
    this.resolver = options.resolver
  }
  async allowed(
    owner: string,
    connector: string,
    fingerprint?: string,
  ): Promise<boolean> {
    const account = await this.auth.getAccount(owner)
    return Boolean(
      account &&
      !account.disabled &&
      !account.deletedAt &&
      !account.resetRequired &&
      account.permissions.includes('models.use') &&
      (await this.auth.connectorAllowed(connector, owner, fingerprint)),
    )
  }
  async internal(token: string): Promise<ModelPrincipal> {
    const connector = await this.auth.authenticateConnector(token)
    if (!connector) throw new ApiError(401, 'invalid connector access token')
    if (
      !(await this.allowed(connector.userId, connector.id, connector.tokenHash))
    )
      throw new ApiError(403, 'model authorization revoked')
    return connector
  }
  async verify(
    owner: string,
    providerId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const provider = (await this.models.list(owner)).find(
      (item) => item.providerId === providerId,
    )
    if (!provider) throw new ApiError(404, 'provider not found')
    const model = await this.models.resolve(
      owner,
      providerId,
      provider.protocol,
      provider.models[0]!.modelId,
    )
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (provider.protocol === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01'
      if (model.key) headers['x-api-key'] = model.key
    } else if (model.key) headers.Authorization = `Bearer ${model.key}`
    const response = await providerRequest({
      url: `${model.baseUrl}/models`,
      method: 'GET',
      headers,
      personal: true,
      allowedOrigins: this.allowedOrigins,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      resolver: this.resolver,
    })
    response.destroy()
    if ((response.statusCode ?? 500) >= 300)
      throw new ApiError(422, 'model provider rejected credential verification')
    return { ok: true, serverTime: utcNow() }
  }
  async forward(options: {
    providerId: string
    protocol: string
    operation: string
    owner: string
    connector: string
    credentialFingerprint?: string
    request: IncomingMessage
    response: ServerResponse
    body: Record<string, unknown>
    signal: AbortSignal
    verifyUser?: () => Promise<unknown>
  }): Promise<void> {
    const { protocol, operation, body } = options
    if (
      !new Set([
        'openai-completions/chat/completions',
        'openai-responses/responses',
        'anthropic-messages/messages',
      ]).has(`${protocol}/${operation}`)
    )
      throw new ApiError(404, 'model protocol route not found')
    if (body.background || typeof body.model !== 'string')
      throw new ApiError(422, 'model request or configuration is invalid')
    if (
      !(await this.allowed(
        options.owner,
        options.connector,
        options.credentialFingerprint,
      ))
    )
      throw new ApiError(
        403,
        'executing device is unavailable or not owned by this account',
      )
    const model = await this.models.resolve(
      options.owner,
      options.providerId,
      protocol,
      body.model,
    )
    const bytes = Buffer.from(JSON.stringify(body))
    if (bytes.length > 8 * 1024 * 1024)
      throw new ApiError(413, 'model request is too large')
    const controller = new AbortController()
    const signal = AbortSignal.any([options.signal, controller.signal])
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: String(options.request.headers.accept ?? 'application/json'),
    }
    if (protocol === 'anthropic-messages') {
      headers['anthropic-version'] = String(
        options.request.headers['anthropic-version'] ?? '2023-06-01',
      )
      if (options.request.headers['anthropic-beta'])
        headers['anthropic-beta'] = String(
          options.request.headers['anthropic-beta'],
        )
      if (model.key) headers['x-api-key'] = model.key
    } else if (model.key) headers.Authorization = `Bearer ${model.key}`
    let checking = false
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      void (async () => {
        if (options.verifyUser) await options.verifyUser()
        if (
          !(await this.allowed(
            options.owner,
            options.connector,
            options.credentialFingerprint,
          ))
        )
          throw new Error('revoked')
      })()
        .catch(() => controller.abort())
        .finally(() => {
          checking = false
        })
    }, 1000)
    timer.unref()
    let upstream: IncomingMessage | undefined
    try {
      upstream = await providerRequest({
        url: `${model.baseUrl}/${operation}`,
        method: 'POST',
        headers,
        body: bytes,
        personal: model.personal,
        allowedOrigins: this.allowedOrigins,
        signal,
        resolver: this.resolver,
      })
      const status = upstream.statusCode ?? 502
      if (status >= 300)
        throw new ApiError(
          status >= 400 && status < 600 ? status : 502,
          'model provider rejected the request',
        )
      options.response.writeHead(status, {
        'Content-Type': upstream.headers['content-type'] ?? 'application/json',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      for await (const chunk of upstream) {
        signal.throwIfAborted()
        if (!options.response.write(chunk))
          await once(options.response, 'drain', { signal })
      }
      options.response.end()
    } finally {
      clearInterval(timer)
      controller.abort()
      upstream?.destroy()
    }
  }
}

export function registerModelRoutes(
  router: ApiRouter,
  models: ModelService,
  proxy: ModelProxy,
): void {
  for (const personal of [false, true]) {
    const base = personal ? '/models/personal' : '/admin/models'
    const permission = personal ? 'models.personal.manage' : 'models.manage'
    const owner = (ctx: ApiContext) => (personal ? ctx.account!.userId : null)
    router.add(
      'GET',
      `${base}/providers`,
      async (ctx) => ({
        providers: await models.list(owner(ctx)),
        serverTime: utcNow(),
      }),
      { permission },
    )
    router.add(
      'POST',
      `${base}/providers`,
      (ctx) => models.save(ctx.body, ctx.account!.userId, owner(ctx)),
      { permission },
    )
    router.add(
      'PATCH',
      `${base}/providers/{provider_id}`,
      (ctx) =>
        models.save(
          ctx.body,
          ctx.account!.userId,
          owner(ctx),
          ctx.params.provider_id,
        ),
      { permission },
    )
    router.add(
      'DELETE',
      `${base}/providers/{provider_id}`,
      async (ctx) => {
        await models.remove(
          ctx.params.provider_id!,
          ctx.account!.userId,
          owner(ctx),
        )
        return { deleted: true, serverTime: utcNow() }
      },
      { permission },
    )
    router.add(
      'GET',
      `${base}/default`,
      async (ctx) => ({
        selection: await models.default(owner(ctx)),
        serverTime: utcNow(),
      }),
      { permission },
    )
    router.add(
      'PUT',
      `${base}/default`,
      async (ctx) => ({
        selection: await models.setDefault(
          ctx.body.selection,
          ctx.account!.userId,
          owner(ctx),
        ),
        serverTime: utcNow(),
      }),
      { permission },
    )
    if (personal)
      for (const verb of ['verify', 'validate'])
        router.add(
          'POST',
          `${base}/providers/{provider_id}/${verb}`,
          (ctx) =>
            proxy.verify(
              ctx.account!.userId,
              ctx.params.provider_id!,
              ctx.signal,
            ),
          { permission },
        )
  }
  router.add(
    'GET',
    '/models/catalog',
    (ctx) => models.catalog(ctx.account!.userId),
    { permission: 'models.use' },
  )
  router.add(
    'GET',
    '/connector/models/catalog',
    async (ctx) =>
      models.catalog((await proxy.internal(bearer(ctx.request))).userId),
    { public: true },
  )
  router.add(
    'POST',
    '/models/{provider_id}/{protocol}/{operation:path}',
    (ctx) =>
      proxy.forward({
        providerId: ctx.params.provider_id!,
        protocol: ctx.params.protocol!,
        operation: ctx.params.operation!,
        owner: ctx.account!.userId,
        connector: requiredText(
          ctx.request.headers['x-superdsh-connector-id'],
          'executing connector',
        ),
        request: ctx.request,
        response: ctx.response,
        body: ctx.body,
        signal: ctx.signal,
        verifyUser: () => ctx.user('models.use'),
      }),
    { permission: 'models.use' },
  )
  router.add(
    'POST',
    '/connector/models/{provider_id}/{protocol}/{operation:path}',
    async (ctx) => {
      const connector = await proxy.internal(bearer(ctx.request))
      return proxy.forward({
        providerId: ctx.params.provider_id!,
        protocol: ctx.params.protocol!,
        operation: ctx.params.operation!,
        owner: connector.userId,
        connector: connector.id,
        credentialFingerprint: connector.tokenHash,
        request: ctx.request,
        response: ctx.response,
        body: ctx.body,
        signal: ctx.signal,
      })
    },
    { public: true },
  )
  for (const catalog of ['model', 'permission'])
    router.add('GET', `/agents/{runtime}/${catalog}-catalog`, (ctx) => {
      ctx.response.writeHead(410, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      ctx.response.end(
        JSON.stringify({
          detail: {
            code: 'agent_catalog_route_removed',
            message:
              'Agent catalog query routes were removed from the v2 target API.',
            use: `/connectors/{connectorId}/runtimes/${ctx.params.runtime}/catalogs/${catalog}`,
          },
        }),
      )
    })
}
