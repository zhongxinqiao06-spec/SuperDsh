/** Private loopback capability. Platform credentials stay exclusively in Electron main. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import type { PlatformAccount } from './platform-account.ts'

export class PlatformModelGateway {
  private server: Server | undefined
  private capability: { origin: string; secret: string } | undefined
  private generation = 0
  private readonly requests = new Set<AbortController>()
  constructor(
    private readonly account: PlatformAccount,
    private readonly connectorId: () => string | null,
  ) {}
  descriptor(): { origin: string; secret: string } | undefined {
    return this.capability
  }
  /** Retire calls before changing account identity; the Host capability stays stable. */
  invalidateIdentity(): void {
    this.generation++
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
  }
  async start(): Promise<void> {
    if (this.server) return
    const secret = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void (async () => {
        response.setHeader('Cache-Control', 'no-store')
        const supplied = [
          ...(request.headers.authorization === undefined
            ? []
            : [
                typeof request.headers.authorization === 'string'
                  ? (/^Bearer (.+)$/i.exec(
                      request.headers.authorization,
                    )?.[1] ?? '')
                  : '',
              ]),
          ...(request.headers['x-api-key'] === undefined
            ? []
            : [
                typeof request.headers['x-api-key'] === 'string'
                  ? request.headers['x-api-key']
                  : '',
              ]),
        ].map((value) => Buffer.from(value))
        const expected = Buffer.from(secret)
        if (
          supplied.length === 0 ||
          supplied.some(
            (value) =>
              value.length !== expected.length ||
              !timingSafeEqual(value, expected),
          )
        ) {
          response.writeHead(401).end()
          return
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const catalog = request.method === 'GET' && url.pathname === '/catalog'
        const match =
          /^\/scopes\/([a-f0-9]{64})\/providers\/([a-zA-Z0-9_-]+)\/(openai-completions\/chat\/completions|openai-responses\/responses|anthropic-messages\/(?:v1\/)?messages)$/.exec(
            url.pathname,
          )
        const supportedQuery =
          !url.search ||
          (match?.[3]?.startsWith('anthropic-messages/') &&
            url.search === '?beta=true')
        if (
          !supportedQuery ||
          (!catalog && (request.method !== 'POST' || !match))
        ) {
          response.writeHead(404).end()
          return
        }
        const identity = this.account.identity()
        const generation = this.generation
        if (catalog && identity === null) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({ scope: null, default: null, providers: [] }),
          )
          return
        }
        if (!identity || (!catalog && match![1] !== identity.key)) {
          response.writeHead(409).end('模型属于已退出的平台账号，请重新选择。')
          return
        }
        const current = () => {
          const next = this.account.identity()
          return (
            this.generation === generation &&
            next?.key === identity.key &&
            next.generation === identity.generation
          )
        }
        const id = this.connectorId()
        if (!catalog && !id) {
          response.writeHead(409).end('请先连接本机设备')
          return
        }
        const controller = new AbortController()
        this.requests.add(controller)
        response.once('close', () => controller.abort())
        response.once('close', () => this.requests.delete(controller))
        const chunks: Buffer[] = []
        let size = 0
        for await (const part of request) {
          const chunk = Buffer.from(part)
          size += chunk.length
          if (size > 32 * 1024 * 1024) {
            response.writeHead(413).end()
            return
          }
          chunks.push(chunk)
        }
        if (!current() || controller.signal.aborted) {
          response.writeHead(409).end('平台账号已切换，请重新选择模型。')
          return
        }
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (id) headers['X-SuperDsh-Connector-Id'] = id
        if (typeof request.headers['anthropic-version'] === 'string')
          headers['anthropic-version'] = request.headers['anthropic-version']
        const path = catalog
          ? '/models/catalog'
          : `/models/${match![2]}/${match![3]!.replace('/v1/messages', '/messages')}`
        const upstream = await this.account.fetch(path, {
          method: catalog ? 'GET' : 'POST',
          headers,
          ...(catalog ? {} : { body: Buffer.concat(chunks) }),
          signal: controller.signal,
        })
        if (!current() || controller.signal.aborted) {
          await upstream.body?.cancel()
          response.writeHead(409).end('平台账号已切换，请重新选择模型。')
          return
        }
        if (catalog) {
          const value = (await upstream.json()) as Record<string, unknown>
          if (!current() || controller.signal.aborted) {
            response.writeHead(409).end('平台账号已切换，请重新选择模型。')
            return
          }
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ...value, scope: identity.key }))
          return
        }
        response.writeHead(upstream.status, {
          'Content-Type':
            upstream.headers.get('content-type') ?? 'application/json',
        })
        if (upstream.body)
          for await (const chunk of upstream.body) {
            if (response.destroyed || !current() || controller.signal.aborted)
              break
            if (!response.write(chunk))
              await once(response, 'drain', { signal: controller.signal })
          }
        response.end()
      })().catch(() => {
        if (response.destroyed) return
        if (!response.headersSent) response.writeHead(502)
        response.end('平台模型请求失败，请检查账号权限和本机连接。')
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.capability = {
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret,
    }
  }
  async close(): Promise<void> {
    this.invalidateIdentity()
    this.capability = undefined
    const server = this.server
    this.server = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
