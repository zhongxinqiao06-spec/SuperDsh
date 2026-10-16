import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export interface PlatformService {
  name: string
  start(): Promise<void>
  close(): Promise<void>
}

export interface RequestContext {
  /** Aborted when the client disconnects or the platform shuts down. */
  signal: AbortSignal
}

export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
) => void | Promise<void>

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>

export interface PlatformServerOptions {
  api: RequestHandler
  web: RequestHandler
  apiUpgrade?: UpgradeHandler
  webUpgrade?: UpgradeHandler
  /** Database, brokers and Next are initialized once, outside page hot reload. */
  services?: readonly PlatformService[]
  hostname?: string
  port?: number
  shutdownTimeoutMs?: number
  onError?: (error: unknown) => void
}

function isApiRequest(request: IncomingMessage): boolean {
  // Decode neither slashes nor dot segments here. The API router must validate
  // its own path; malformed API requests must never fall through to web pages.
  const path = (request.url || '/').split('?', 1)[0] || '/'
  return path === '/api/v2' || path.startsWith('/api/v2/')
}

/** Shared transport/lifecycle for Next pages and API v2, with no Python proxy. */
export function createPlatformServer(options: PlatformServerOptions) {
  const services = options.services || []
  if (new Set(services.map((service) => service.name)).size !== services.length)
    throw new Error('Platform service names must be unique')

  const shutdownTimeout = options.shutdownTimeoutMs ?? 5000
  if (!Number.isFinite(shutdownTimeout) || shutdownTimeout < 1)
    throw new Error('shutdownTimeoutMs must be positive')

  const initialized: PlatformService[] = []
  const sockets = new Set<Socket>()
  const requests = new Set<AbortController>()
  let startPromise: Promise<AddressInfo> | undefined
  let closePromise: Promise<void> | undefined
  let closing = false
  let accepting = false

  const report = (error: unknown) => {
    try {
      options.onError?.(error)
    } catch {
      // A logging callback must not prevent cleanup or expose errors to clients.
    }
  }

  const server = createServer((request, response) => {
    if (!accepting || closing) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ detail: 'server is shutting down' }))
      return
    }
    const controller = new AbortController()
    requests.add(controller)
    const disconnected = () => controller.abort()
    const finished = () => {
      requests.delete(controller)
      request.removeListener('aborted', disconnected)
      if (!response.writableFinished) disconnected()
    }
    request.once('aborted', disconnected)
    response.once('close', finished)
    const handler = isApiRequest(request) ? options.api : options.web
    Promise.resolve()
      .then(() => handler(request, response, { signal: controller.signal }))
      .catch((error: unknown) => {
        report(error)
        if (response.destroyed) return
        if (response.headersSent) {
          response.destroy()
          return
        }
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ detail: 'internal server error' }))
      })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (request, socket, head) => {
    const handler = isApiRequest(request)
      ? options.apiUpgrade
      : options.webUpgrade
    if (closing || !accepting || !handler) {
      const status =
        closing || !accepting ? '503 Service Unavailable' : '404 Not Found'
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
      return
    }
    Promise.resolve()
      .then(() => handler(request, socket, head))
      .catch((error: unknown) => {
        report(error)
        socket.destroy()
      })
  })

  async function closeServices(): Promise<void> {
    const errors: unknown[] = []
    while (initialized.length) {
      const service = initialized.pop()!
      try {
        await service.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Platform shutdown failed')
  }

  function start(): Promise<AddressInfo> {
    if (closing) return Promise.reject(new Error('Platform server is closed'))
    startPromise ??= (async () => {
      try {
        for (const service of services) {
          // Include a partially initialized service in rollback too.
          initialized.push(service)
          await service.start()
          if (closing) throw new Error('Platform startup was cancelled')
        }
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => {
            server.removeListener('listening', listening)
            reject(error)
          }
          const listening = () => {
            server.removeListener('error', failed)
            resolve()
          }
          server.once('error', failed)
          server.once('listening', listening)
          server.listen(options.port ?? 5174, options.hostname ?? '127.0.0.1')
        })
        server.on('error', report)
        accepting = !closing
        return server.address() as AddressInfo
      } catch (error) {
        try {
          await closeServices()
        } catch (cleanupError) {
          report(cleanupError)
        }
        throw error
      }
    })()
    return startPromise
  }

  function close(): Promise<void> {
    closing = true
    accepting = false
    closePromise ??= (async () => {
      try {
        await startPromise
      } catch {
        // Failed startup already rolled back its initialized services.
      }
      for (const controller of requests) controller.abort()
      if (server.listening) {
        await new Promise<void>((resolve) => {
          const forceClose = setTimeout(() => {
            // Includes upgraded WebSocket sockets, which closeAllConnections
            // alone does not close. Brokers get the grace interval to drain.
            for (const socket of sockets) socket.destroy()
          }, shutdownTimeout)
          forceClose.unref()
          server.close(() => {
            clearTimeout(forceClose)
            resolve()
          })
          server.closeIdleConnections()
        })
      }
      await closeServices()
    })()
    return closePromise
  }

  return { start, close }
}
