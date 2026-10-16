import type { RequestHandler } from './platform-server.ts'
import type { RedisCoordinator } from '../infrastructure/redis-coordinator.ts'

export function apiMiddleware(
  handler: RequestHandler,
  options: { origins: string[]; redis: Pick<RedisCoordinator, 'take'> },
): RequestHandler {
  const allowed = new Set(options.origins)
  return async (request, response, context) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const origin = request.headers.origin
    if (origin && allowed.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Access-Control-Allow-Credentials', 'true')
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      if (origin && !allowed.has(origin)) {
        response.writeHead(403)
        response.end()
        return
      }
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      )
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-SuperDsh-Agent-Preparation, X-SuperDsh-Connector-Id, X-Request-Id',
      )
      response.setHeader('Access-Control-Max-Age', '600')
      response.writeHead(204)
      response.end()
      return
    }
    const path = (request.url || '/').split('?')[0]!
    const auth =
      /^\/api\/v2\/(?:auth\/(?:login|register|password-salt|password-reset|email)|oauth\/token|pairing)/.test(
        path,
      )
    if (auth && request.method === 'POST') {
      // Forwarded headers are not trusted as identity; edge proxies can impose
      // a second limit. Bucket names contain no password, login or bearer token.
      let admitted: boolean
      try {
        admitted = await options.redis.take(
          `${request.socket.remoteAddress}:${path}`,
          60,
          60_000,
        )
      } catch {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ detail: 'authentication temporarily unavailable' }),
        )
        return
      }
      if (!admitted) {
        response.writeHead(429, {
          'content-type': 'application/json',
          'Retry-After': '60',
        })
        response.end(
          JSON.stringify({
            detail: 'too many authentication requests; retry later',
          }),
        )
        return
      }
    }
    await handler(request, response, context)
  }
}
