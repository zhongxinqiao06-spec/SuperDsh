import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestHandler } from './platform-server.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly sessionId?: string
  constructor(
    status: number,
    detail: string,
    metadata: { code?: string; sessionId?: string } = {},
  ) {
    super(detail)
    this.status = status
    this.code = metadata.code
    this.sessionId = metadata.sessionId
  }
}

export interface Account {
  userId: string
  username: string | null
  email: string | null
  emailVerified: boolean
  displayName: string | null
  role: string
  roles: string[]
  permissions: string[]
  authzVersion: number
  resetRequired: boolean
  disabled: boolean
  deletedAt: string | null
  [key: string]: unknown
}

export type Authorize = (
  request: IncomingMessage,
  permission?: string,
) => Promise<Account>
export interface ApiContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  params: Record<string, string>
  body: Record<string, unknown>
  json: unknown
  signal: AbortSignal
  account: Account | null
  user(permission?: string): Promise<Account>
}
export type ApiHandler = (context: ApiContext) => Promise<unknown> | unknown
export interface ApiRouteOptions {
  public?: boolean
  permission?: string
  status?: number
  rawBody?: boolean
}
interface Route {
  method: string
  path: string
  pattern: RegExp
  parameters: string[]
  handler: ApiHandler
  options: ApiRouteOptions
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
export function requiredText(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ApiError(422, `${name} is required or invalid`)
  return value
}
export function integer(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === null || value === '') return fallback
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new ApiError(422, 'invalid integer parameter')
  return result
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, 'expected an object')
  return value as Record<string, unknown>
}
export function utcNow(): string {
  return new Date().toISOString()
}
export function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 8 * 1024 * 1024)
      throw new ApiError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(422, 'invalid JSON request body')
  }
}

export class ApiRouter {
  readonly routes: Route[] = []
  private readonly authorize: Authorize
  constructor(authorize: Authorize) {
    this.authorize = authorize
  }

  add(
    method: string,
    path: string,
    handler: ApiHandler,
    options: ApiRouteOptions = {},
  ): void {
    const fullPath = path.startsWith('/api/v2') ? path : `/api/v2${path}`
    if (
      this.routes.some(
        (route) =>
          route.method === method.toUpperCase() && route.path === fullPath,
      )
    )
      throw new Error(`Duplicate API route: ${method} ${fullPath}`)
    const parameters: string[] = []
    const pattern = fullPath
      .split('/')
      .map((segment) => {
        const parameter = /^\{([\w]+)(:path)?\}$/.exec(segment)
        if (parameter) {
          parameters.push(parameter[1]!)
          return parameter[2] ? '(.+)' : '([^/]+)'
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/')
    this.routes.push({
      method: method.toUpperCase(),
      path: fullPath,
      pattern: new RegExp(`^${pattern}/?$`),
      parameters,
      handler,
      options,
    })
    // Literal routes win over parameters irrespective of module registration order.
    this.routes.sort((a, b) => a.parameters.length - b.parameters.length)
  }

  handle: RequestHandler = async (request, response, { signal }) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost')
      const route = this.routes.find(
        (candidate) =>
          candidate.method === request.method &&
          candidate.pattern.test(url.pathname),
      )
      if (!route) throw new ApiError(404, 'not found')
      const match = route.pattern.exec(url.pathname)!
      const params: Record<string, string> = {}
      for (const [index, name] of route.parameters.entries()) {
        try {
          params[name] = decodeURIComponent(match[index + 1]!)
        } catch {
          throw new ApiError(400, 'invalid path encoding')
        }
      }
      const account = route.options.public
        ? null
        : await this.authorize(request, route.options.permission)
      const parsedBody = route.options.rawBody ? {} : await jsonBody(request)
      const context: ApiContext = {
        request,
        response,
        url,
        params,
        signal,
        account,
        json: parsedBody,
        body:
          parsedBody &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody)
            ? (parsedBody as Record<string, unknown>)
            : {},
        user: (permission) => this.authorize(request, permission),
      }
      const result = await route.handler(context)
      if (response.headersSent || response.writableEnded || response.destroyed)
        return
      const status = route.options.status ?? (result === undefined ? 204 : 200)
      response.statusCode = status
      if (status === 204) {
        response.end()
        return
      }
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify(result ?? null))
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (response.destroyed) return
      response.statusCode = error instanceof ApiError ? error.status : 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(
        JSON.stringify({
          detail:
            error instanceof ApiError ? error.message : 'internal server error',
          ...(error instanceof ApiError && error.code
            ? { code: error.code }
            : {}),
          ...(error instanceof ApiError && error.sessionId
            ? { sessionId: error.sessionId }
            : {}),
        }),
      )
    }
  }
}
