import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ApiError, ApiRouter, utcNow } from './http/api-router.ts'
import { apiMiddleware } from './http/api-middleware.ts'
import type { PlatformService, UpgradeHandler } from './http/platform-server.ts'
import type { ServerConfiguration } from './infrastructure/configuration.ts'
import type { Database, DatabaseLease } from './infrastructure/database.ts'
import {
  ensureSchema,
  schemaRevision,
  schemaVersion,
} from './infrastructure/schema.ts'
import type { RedisCoordinator } from './infrastructure/redis-coordinator.ts'
import { IdentityService } from './identity/service.ts'
import { registerIdentityRoutes } from './identity/routes.ts'
import { registerManagementRoutes } from './management/routes.ts'
import { ConnectorHub } from './devices/connector-hub.ts'
import { registerDeviceRoutes } from './devices/routes.ts'
import { NativeDevice } from './devices/native-device.ts'
import { registerConversationRoutes } from './conversations/routes.ts'
import { FileService } from './files/service.ts'
import { ModelService } from './models/model-service.ts'
import { ModelProxy, registerModelRoutes } from './models/model-routes.ts'
import {
  ServerAgentService,
  registerServerAgentRoutes,
} from './runtime/server-agents.ts'
import { BusinessAgentService } from './agents/service.ts'
import { registerBusinessAgentRoutes } from './agents/routes.ts'
import { executeAgentTool } from './agents/execution.ts'
import { AgentResourceService } from './agents/resources.ts'
import { registerAgentResourceRoutes } from './agents/resource-routes.ts'
import { registerKnowledgeIndexRoutes } from './agents/knowledge-routes.ts'
import { QdrantKnowledgeIndex } from './agents/knowledge-index.ts'

export interface ApplicationOptions {
  configuration: ServerConfiguration
  database: Database
  redis: RedisCoordinator
  /** Set only after the CLI verifies the exact managed development container. */
  bootstrapDevelopment?: boolean
  onOwnershipLost?: (error: Error) => void
  log?: (message: string) => void
}

/** Composition owns all API modules. Next pages do not initialize backend state. */
export function createApplication(options: ApplicationOptions) {
  const { configuration: config, database: db, redis } = options
  const log = options.log ?? console.log
  const instanceId = randomUUID()
  let ownership: DatabaseLease | null = null
  let closed = false
  let closing: Promise<void> | undefined
  const identity = new IdentityService(db, {
    secret: config.secret,
    setupToken: config.setupToken || randomBytes(24).toString('base64url'),
    setupTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    onPrepareAgent: (id) => {
      if (!closed) void agents.prepare(id).catch(() => {})
    },
    onAccountChanged: async (id, reason) => {
      await hub.revalidateUser(id)
      if (reason !== 'session') await agents.revoke(id)
    },
  })
  const hub = new ConnectorHub({
    database: db,
    secret: config.secret,
    getUser: (id) => identity.getUser(id),
    authenticateToken: async (token) => {
      const user = await identity.authenticateToken(token)
      if (!user) throw new ApiError(401, 'login session expired or revoked')
      return user
    },
  })
  const audit = (
    actor: string,
    action: string,
    target: string,
    detail?: Record<string, unknown>,
    connection?: import('./infrastructure/database.ts').SqlConnection,
  ) => identity.audit(actor, action, target, detail, connection)
  const files = new FileService(hub, config.filesDirectory)
  const business = new BusinessAgentService({
    db,
    hub,
    files,
    knowledgeIndex: new QdrantKnowledgeIndex(
      config.qdrantUrl || 'http://127.0.0.1:16333',
      config.qdrantApiKey,
    ),
    getAccount: (id) => identity.getUser(id),
    audit,
  })
  const models = new ModelService({
    db,
    encryptionKey: config.encryptionKey,
    audit,
  })
  const proxy = new ModelProxy({
    models,
    auth: {
      getAccount: async (id) => {
        try {
          return await identity.getUser(id)
        } catch {
          return null
        }
      },
      authenticateConnector: async (token) => {
        try {
          return await hub.authenticateConnector(token)
        } catch {
          return null
        }
      },
      connectorAllowed: async (id, owner, fingerprint) => {
        try {
          const row = await hub.connectorAllowed(id)
          return (
            row.user_id === owner &&
            (!fingerprint || row.token_hash === fingerprint)
          )
        } catch {
          return false
        }
      },
    },
  })
  const agents = new ServerAgentService({
    business: {
      bindings: (owner) => business.bindings(owner),
      binding: (owner, session) => business.binding(owner, session),
      execute: (owner, session, tool, args, signal, context) =>
        executeAgentTool(business, owner, session, tool, args, signal, context),
    },
    db,
    rootDirectory: join(config.dataDirectory, 'agents'),
    hub,
    models,
    proxy,
    audit,
    getAccount: async (id) => {
      try {
        return await identity.getUser(id)
      } catch {
        return null
      }
    },
    attachment: (connector, session, file) =>
      files.downloadAttachment(connector, session, file),
    platform: (_user, workspace, context) =>
      new NativeDevice(
        workspace,
        (method, params) => hub.notify(context.connectorId, method, params),
        Object.fromEntries(
          Object.entries(context.environment).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      ),
  })
  const router = new ApiRouter(identity.authorize)
  registerIdentityRoutes(router, identity)
  registerManagementRoutes(router, identity, {
    instanceId,
    version: '0.1.7.2',
    databaseUrl: config.databaseUrl,
    isOnline: (id) => hub.isOnline(id),
    disconnect: (id) => hub.disconnect(id),
  })
  registerDeviceRoutes(router, hub)
  registerConversationRoutes(router, hub, files, business)
  registerBusinessAgentRoutes(router, business)
  registerAgentResourceRoutes(
    router,
    new AgentResourceService(business.options),
  )
  registerKnowledgeIndexRoutes(router, business)
  files.register(router)
  registerModelRoutes(router, models, proxy)
  registerServerAgentRoutes(router, agents)
  for (const path of ['/health', '/health/live'])
    router.add(
      'GET',
      path,
      () => ({ status: 'ok', version: '0.1.7.2', serverTime: utcNow() }),
      { public: true },
    )
  router.add(
    'GET',
    '/health/ready',
    async ({ response }) => {
      let databaseReady = false
      try {
        databaseReady =
          (await db.query('SELECT version_num FROM alembic_version'))[0]
            ?.version_num === schemaRevision
      } catch {
        /* only expose dependency state */
      }
      const redisReady = await redis.ready()
      const ready = databaseReady && redisReady && !!ownership && !closed
      response.statusCode = ready ? 200 : 503
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          checks: {
            database: { status: databaseReady ? 'ok' : 'error', schemaVersion },
            redis: { status: redisReady ? 'ok' : 'error' },
            realtime: { status: ownership && !closed ? 'ok' : 'error' },
          },
          instanceId,
          serverTime: utcNow(),
        }),
      )
    },
    { public: true },
  )

  const close = (): Promise<void> => {
    closed = true
    closing ??= (async () => {
      // Stop tool processes before releasing ownership. A failed stop must not
      // make a second platform eligible to reuse the same writable Home.
      await agents.close()
      await files.close()
      await hub.close()
      await ownership?.release()
      ownership = null
    })()
    return closing
  }
  const service: PlatformService = {
    name: 'platform-api',
    async start() {
      ownership = await db.lease('superdsh:platform-api')
      if (!ownership)
        throw new Error(
          'Another Node platform already owns this database; stop it before starting another instance',
        )
      void ownership.lost.then(async (error) => {
        try {
          await close()
        } finally {
          options.onOwnershipLost?.(error)
        }
      })
      await ensureSchema(db)
      await identity.seedBuiltinRoles()
      const empty = !(await db.query('SELECT id FROM users LIMIT 1')).length
      if (empty && options.bootstrapDevelopment) {
        await identity.createUser(
          { username: 'admin', displayName: 'admin', password: 'admin123' },
          { role: 'admin', bootstrap: true },
        )
        log(
          'Development administrator created: admin / admin123. Existing passwords are never reset.',
        )
      } else if (empty)
        log(
          `Initial administrator setup token (valid 1 hour): ${identity.options.setupToken}`,
        )
      // Connections cannot survive a platform process replacement. Persisted
      // tasks are not replayed; clients reconnect and refresh from the Host.
      await db.query(
        "UPDATE connectors SET status='offline',presence_connection_id=NULL WHERE status<>'offline'",
      )
      await db.query(
        "UPDATE server_agents SET status='stopped',lease_expires_at=0 WHERE status IN ('starting','running')",
      )
      agents.startWatchdog()
    },
    close,
  }
  const upgrade: UpgradeHandler = async (request, socket, head) => {
    if (await files.handleUpgrade(request, socket, head)) return
    if (await hub.handleUpgrade(request, socket, head)) return
    socket.end(
      'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    )
  }
  return {
    service,
    router,
    identity,
    hub,
    files,
    models,
    proxy,
    agents,
    business,
    upgrade,
    handle: apiMiddleware(router.handle, { origins: config.origins, redis }),
    websocketPaths: [...hub.websocketPaths, ...files.websocketPaths],
  }
}
