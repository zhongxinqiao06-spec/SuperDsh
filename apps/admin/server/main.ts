import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createServer as createPortProbe } from 'node:net'
import { createApplication } from './application.ts'
import { serverConfiguration } from './infrastructure/configuration.ts'
import type { ServerConfiguration } from './infrastructure/configuration.ts'
import { createDatabase } from './infrastructure/database.ts'
import { RedisCoordinator } from './infrastructure/redis-coordinator.ts'
import { createPlatformServer } from './http/platform-server.ts'
import { nextApplication } from './http/next-application.ts'

export async function startNodePlatform(
  config: ServerConfiguration = serverConfiguration(),
  options: {
    web?: boolean
    bootstrapDevelopment?: boolean
    log?: (message: string) => void
    onOwnershipLost?: () => void
  } = {},
) {
  // Diagnose occupied user-facing ports before touching schema or live presence.
  for (const port of new Set([config.port, config.apiPort])) {
    if (port === 0) continue
    await new Promise<void>((resolve, reject) => {
      const probe = createPortProbe()
      probe.once('error', () =>
        reject(
          new Error(
            `Port ${port} is already occupied; stop the previous web/API service before starting the Node platform`,
          ),
        ),
      )
      probe.listen(port, config.hostname, () =>
        probe.close((error) => (error ? reject(error) : resolve())),
      )
    })
  }
  const log = options.log ?? console.log
  const db = createDatabase(config.databaseUrl)
  const redis = new RedisCoordinator(config.redisUrl, config.databaseUrl)
  let close: () => Promise<void> = async () => {}
  const app = createApplication({
    configuration: config,
    database: db,
    redis,
    bootstrapDevelopment: options.bootstrapDevelopment,
    log,
    onOwnershipLost: () => {
      log('Database ownership lost; stopping the platform and native Agents')
      void close()
        .finally(() => options.onOwnershipLost?.())
        .catch(() =>
          log('Platform cleanup failed after losing database ownership'),
        )
    },
  })
  process.env.SUPERDSH_NATIVE_PLATFORM = '1'
  const web =
    options.web === false
      ? null
      : nextApplication({
          dev: config.dev,
          hostname: config.hostname,
          port: config.port,
        })
  const primary = createPlatformServer({
    hostname: config.hostname,
    port: config.port,
    api: app.handle,
    apiUpgrade: app.upgrade,
    web:
      web?.handle ??
      ((_request, response) => {
        response.writeHead(404)
        response.end()
      }),
    webUpgrade: web?.upgrade,
    services: [
      {
        name: 'database',
        start: async () => {
          await db.query('SELECT 1')
        },
        close: () => db.close(),
      },
      { name: 'redis', start: () => redis.start(), close: () => redis.close() },
      app.service,
      ...(web ? [web] : []),
    ],
    onError: () =>
      log('Platform request failed; inspect application diagnostics'),
  })
  // Preserve existing desktop/Android API addresses while browsers use one
  // same-origin listener. Both listeners share the exact same backend instance.
  const api =
    config.apiPort === config.port
      ? null
      : createPlatformServer({
          hostname: config.hostname,
          port: config.apiPort,
          api: app.handle,
          apiUpgrade: app.upgrade,
          web: (_request, response) => {
            response.writeHead(404)
            response.end()
          },
          onError: () => log('Platform API request failed'),
        })
  let closing: Promise<void> | undefined
  close = () => {
    closing ??= (async () => {
      await api?.close()
      await primary.close()
    })()
    return closing
  }
  let address: AddressInfo
  let apiAddress: AddressInfo
  try {
    address = await primary.start()
    apiAddress = api ? await api.start() : address
  } catch (error) {
    await close()
    throw error
  }
  return { address, apiAddress, app, close }
}

async function main(): Promise<void> {
  const config = serverConfiguration()
  const platform = await startNodePlatform(config, {
    bootstrapDevelopment: process.env.SUPERDSH_BOOTSTRAP_DEV_ADMIN === '1',
    onOwnershipLost: () => process.exit(1),
  })
  console.log(
    `SuperDsh web + Node API: http://${config.hostname}:${platform.address.port}`,
  )
  console.log(
    `Desktop/Android API: http://${config.hostname}:${platform.apiAddress.port}`,
  )
  console.log(
    'Server Agents use native Harness processes. Ctrl+C stops the platform and its owned processes.',
  )
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      await platform.close()
    } catch {
      console.error('Some platform resources could not stop cleanly')
      process.exitCode = 1
    }
    // Next's CLI also exits after services drain: its dev compiler keeps watchers.
    // Owned Hosts, database leases and sockets must finish cleanup first.
    process.exit(process.exitCode || 0)
  }
  process.once('SIGINT', () => {
    void stop()
  })
  process.once('SIGTERM', () => {
    void stop()
  })
  process.once('disconnect', () => {
    void stop()
  })
  process.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'superdsh:shutdown'
    )
      void stop()
  })
  process.send?.({
    type: 'superdsh:ready',
    port: platform.address.port,
    apiPort: platform.apiAddress.port,
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error: unknown) => {
    // Configuration errors contain variable names, never their values. Avoid
    // dumping pg connection objects or providers' response bodies into logs.
    console.error(
      error instanceof Error ? error.message : 'Platform failed to start',
    )
    process.exit(1)
  })
}
