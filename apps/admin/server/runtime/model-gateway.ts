import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { ApiError, object } from '../http/api-router.ts'
import type { ModelProxy } from '../models/model-routes.ts'

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
/** Fixed per-user loopback capability; the child never receives login tokens or provider keys. */
export class ModelGateway {
  readonly secret = randomBytes(48).toString('base64url')
  private readonly options: {
    proxy: ModelProxy
    owner: string
    connector: string
    fingerprint: string
  }
  private scope: string | null = null
  private readonly requests = new Set<AbortController>()
  private readonly server = createServer((request, response) => {
    const controller = new AbortController()
    this.requests.add(controller)
    response.once('close', () => controller.abort())
    void (async () => {
      const authorization = request.headers.authorization
      const apiKey = request.headers['x-api-key']
      if (
        (!authorization && !apiKey) ||
        (authorization !== undefined &&
          !equal(authorization, `Bearer ${this.secret}`)) ||
        (apiKey !== undefined &&
          (typeof apiKey !== 'string' || !equal(apiKey, this.secret)))
      )
        throw new ApiError(401, 'invalid model capability')
      if (
        !(await this.options.proxy.allowed(
          this.options.owner,
          this.options.connector,
          this.options.fingerprint,
        ))
      )
        throw new ApiError(403, 'model authorization revoked')
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (
        request.method === 'GET' &&
        url.pathname === '/catalog' &&
        !url.search
      ) {
        const catalog = await this.options.proxy.models.catalog(
          this.options.owner,
        )
        this.scope = String(catalog.scope)
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        response.end(JSON.stringify(catalog))
        return
      }
      const match =
        /^\/scopes\/([a-f0-9]{64})\/providers\/([A-Za-z0-9_-]+)\/(openai-completions|openai-responses|anthropic-messages)\/(chat\/completions|responses|(?:v1\/)?messages)$/.exec(
          url.pathname,
        )
      if (
        request.method !== 'POST' ||
        !match ||
        (url.search &&
          !(match[3] === 'anthropic-messages' && url.search === '?beta=true'))
      )
        throw new ApiError(404, 'unknown model route')
      if (match[1] !== this.scope)
        throw new ApiError(403, 'model route does not belong to this identity')
      const chunks: Buffer[] = []
      let size = 0
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        size += chunk.length
        if (size > 8 * 1024 * 1024)
          throw new ApiError(413, 'model request is too large')
        chunks.push(chunk)
      }
      let body: Record<string, unknown>
      try {
        body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        throw new ApiError(422, 'invalid model request')
      }
      await this.options.proxy.forward({
        providerId: match[2]!,
        protocol: match[3]!,
        operation: match[4]!.replace(/^v1\//, ''),
        owner: this.options.owner,
        connector: this.options.connector,
        credentialFingerprint: this.options.fingerprint,
        request,
        response,
        body,
        signal: controller.signal,
      })
    })()
      .catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        if (response.destroyed) return
        response.writeHead(error instanceof ApiError ? error.status : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        response.end(
          JSON.stringify({
            detail:
              error instanceof ApiError
                ? error.message
                : 'model authorization unavailable',
          }),
        )
      })
      .finally(() => this.requests.delete(controller))
  })
  constructor(options: {
    proxy: ModelProxy
    owner: string
    connector: string
    fingerprint: string
  }) {
    this.options = options
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 15_000
  }
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }
  async close(): Promise<void> {
    for (const request of this.requests) request.abort()
    this.server.closeAllConnections()
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
