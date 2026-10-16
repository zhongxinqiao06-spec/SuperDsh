import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type {
  NextServerOptions,
  NextServer,
  NextBundlerOptions,
} from 'next/dist/server/next.js'
import type {
  PlatformService,
  RequestHandler,
  UpgradeHandler,
} from './platform-server.ts'

export function nextApplication(options: {
  dev: boolean
  hostname: string
  port: number
}): PlatformService & { handle: RequestHandler; upgrade: UpgradeHandler } {
  // Next installs its own unfiltered upgrade listener. Give it a private server
  // so it can never consume authenticated API/Connector WebSocket upgrades.
  const upgrades = createServer()
  const createNext = createRequire(import.meta.url)('next') as (
    options: NextServerOptions & NextBundlerOptions,
  ) => Pick<
    NextServer,
    'prepare' | 'close' | 'getRequestHandler' | 'getUpgradeHandler'
  >
  const application = createNext({
    ...options,
    dir: fileURLToPath(new URL('../../', import.meta.url)),
    httpServer: upgrades,
  })
  return {
    name: 'next',
    start: () => application.prepare(),
    close: () => application.close(),
    handle: (request, response) =>
      application.getRequestHandler()(request, response),
    upgrade: (request, socket, head) => {
      // This is the router-server listener installed on the first page request.
      // Next's getUpgradeHandler() delegates to the rendering server instead,
      // which does not own HMR in this Next version.
      if (!upgrades.emit('upgrade', request, socket, head))
        socket.end(
          'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        )
    },
  }
}
