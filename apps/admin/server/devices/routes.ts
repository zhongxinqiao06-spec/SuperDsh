import { randomInt } from 'node:crypto'
import {
  ApiError,
  bearer,
  integer,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type { ApiContext, ApiRouter } from '../http/api-router.ts'
import { json } from '../infrastructure/database.ts'
import type { Row } from '../infrastructure/database.ts'
import {
  connectorView,
  hashToken,
  identifier,
  record,
  runtimeView,
} from '../conversations/store.ts'
import type { ConnectorHub } from './connector-hub.ts'

export function registerDeviceRoutes(
  router: ApiRouter,
  hub: ConnectorHub,
): void {
  const { store } = hub,
    db = store.db
  const own = async (ctx: ApiContext) =>
    store.connector(ctx.params.connector_id!, ctx.account!.userId)
  const response = (connector: Row) => ({
    connector: connectorView(connector, hub.isOnline(text(connector.id))),
    serverTime: utcNow(),
  })
  router.add(
    'GET',
    '/connectors',
    async (ctx) => ({
      connectors: await store.connectors(ctx.account!.userId),
      serverTime: utcNow(),
    }),
    { permission: 'devices.read' },
  )
  router.add(
    'POST',
    '/connectors',
    async (ctx) => {
      const result = await store.createConnector(ctx.account!.userId, ctx.body)
      await hub.disconnect(text(record(result.connector).id))
      await hub.changed(text(record(result.connector).id))
      return result
    },
    { permission: 'devices.manage' },
  )
  router.add(
    'GET',
    '/connectors/{connector_id}',
    async (ctx) => response(await own(ctx)),
    { permission: 'devices.read' },
  )
  router.add(
    'PATCH',
    '/connectors/{connector_id}',
    async (ctx) => {
      const connector = await own(ctx)
      if (ctx.body.name !== undefined)
        await db.query(
          'UPDATE connectors SET name=$2,updated_at=$3 WHERE id=$1',
          [connector.id, requiredText(ctx.body.name, 'name', 255), utcNow()],
        )
      await hub.changed(text(connector.id))
      return response(await own(ctx))
    },
    { permission: 'devices.manage' },
  )
  router.add(
    'DELETE',
    '/connectors/{connector_id}',
    async (ctx) => {
      const connector = await own(ctx)
      if (connector.executor_kind === 'server-agent')
        throw new ApiError(
          409,
          'server Agent lifecycle is managed by the platform',
        )
      await db.query(
        'UPDATE connectors SET revoked=1,updated_at=$2 WHERE id=$1',
        [connector.id, utcNow()],
      )
      await hub.disconnect(text(connector.id))
      await hub.changed(text(connector.id))
    },
    { permission: 'devices.manage' },
  )
  router.add(
    'POST',
    '/connectors/{connector_id}/revoke',
    async (ctx) => {
      const connector = await own(ctx)
      if (connector.executor_kind === 'server-agent')
        throw new ApiError(
          409,
          'server Agent credentials are managed by the platform',
        )
      const token = identifier('agt')
      await db.query(
        'UPDATE connectors SET token_hash=$2,token_prefix=$3,updated_at=$4 WHERE id=$1',
        [connector.id, hashToken(token), token.slice(0, 12), utcNow()],
      )
      await hub.disconnect(text(connector.id))
      return {
        ...response(await own(ctx)),
        connectorToken: token,
        tokenPrefix: token.slice(0, 12),
      }
    },
    { permission: 'devices.manage' },
  )
  router.add(
    'GET',
    '/connectors/{connector_id}/preferences',
    async (ctx) => ({
      connectorId: ctx.params.connector_id,
      preferences: json((await own(ctx)).user_preferences, {}),
      serverTime: utcNow(),
    }),
    { permission: 'devices.read' },
  )
  router.add(
    'GET',
    '/connectors/{connector_id}/protocol/capabilities',
    async (ctx) => {
      await own(ctx)
      throw new ApiError(
        410,
        'use /connectors/{connector_id}/runtimes/{runtime_id}/capabilities',
      )
    },
    { permission: 'devices.read' },
  )
  router.add(
    'POST',
    '/connector/auth',
    (ctx) => hub.exchangeConnector(ctx.request.headers.authorization || ''),
    { public: true },
  )
  router.add(
    'POST',
    '/connector/ingest',
    async (ctx) =>
      hub.ingest(
        (await hub.authenticateConnector(bearer(ctx.request))).id,
        ctx.body,
      ),
    { public: true },
  )
  router.add('POST', '/ws-ticket', async (ctx) => {
    const scope = record(ctx.body.scope),
      account = await ctx.user(
        scope.dashboard ? 'devices.read' : 'sessions.read',
      )
    const target = scope.dashboard
      ? 'dashboard'
      : requiredText(scope.sessionId, 'sessionId')
    if (target !== 'dashboard') await store.session(target, account.userId)
    return hub.issueTicket(
      bearer(ctx.request),
      account.userId,
      requiredText(ctx.body.clientId, 'clientId'),
      target,
    )
  })
  const runtime = async (ctx: ApiContext): Promise<Row> => {
    await own(ctx)
    const [row] = await db.query(
      'SELECT t.*,r.* FROM device_runtimes r LEFT JOIN connector_runtime_types t ON t.connector_id=r.connector_id AND t.runtime_type=r.runtime_type WHERE r.connector_id=$1 AND r.runtime_id=$2',
      [ctx.params.connector_id, ctx.params.runtime_id],
    )
    if (!row) throw new ApiError(404, 'runtime not found')
    return row
  }
  const runtimeTypes = async (id: string) =>
    (
      await db.query(
        'SELECT * FROM connector_runtime_types WHERE connector_id=$1 ORDER BY recommendation_rank NULLS LAST,display_name',
        [id],
      )
    ).map((row) => ({
      connectorId: id,
      runtimeType: row.runtime_type,
      implementationType: row.implementation_type,
      displayName: row.display_name,
      description: row.description,
      present: !!row.present,
      available: !!row.available,
      reason: row.reason,
      recommended: !!row.recommended,
      recommendationRank: row.recommendation_rank,
      discovery: json(row.discovery_json, {}),
      configSchema: json(row.config_schema_json, null),
      schema: record(json(row.config_schema_json, {})).schema || null,
      uiSchema: json(row.ui_schema_json, {}),
      defaults: json(row.defaults_json, {}),
      capabilities: json(row.capabilities_json, {}),
      metadata: json(row.metadata_json, {}),
      instancePolicy: row.instance_policy,
      maxInstances: row.max_instances,
      lastDiscoveredAt: row.last_discovered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  for (const discovery of [false, true])
    for (const types of [false, true]) {
      const part = types ? 'runtime-types' : 'runtimes'
      router.add(
        discovery ? 'POST' : 'GET',
        `/connectors/{connector_id}/${part}${discovery ? '/discover' : ''}`,
        async (ctx) => {
          await own(ctx)
          if (discovery) await hub.discover(ctx.params.connector_id!)
          const values = types
            ? await runtimeTypes(ctx.params.connector_id!)
            : (
                await db.query(
                  'SELECT t.*,r.* FROM device_runtimes r LEFT JOIN connector_runtime_types t ON t.connector_id=r.connector_id AND t.runtime_type=r.runtime_type WHERE r.connector_id=$1',
                  [ctx.params.connector_id],
                )
              ).map(runtimeView)
          return {
            connectorId: ctx.params.connector_id,
            [types ? 'runtimeTypes' : 'runtimes']: values,
            serverTime: utcNow(),
          }
        },
        { permission: discovery ? 'devices.manage' : 'devices.read' },
      )
    }
  router.add(
    'POST',
    '/connectors/{connector_id}/runtimes',
    async (ctx) => {
      const connector = await own(ctx)
      if (connector.executor_kind === 'server-agent')
        throw new ApiError(409, 'managed runtime cannot be edited')
      const type = requiredText(ctx.body.runtimeType, 'runtimeType'),
        name = requiredText(ctx.body.name, 'name', 128),
        now = utcNow()
      const [provider] = await db.query(
        'SELECT * FROM connector_runtime_types WHERE connector_id=$1 AND runtime_type=$2',
        [connector.id, type],
      )
      if (!provider) throw new ApiError(404, 'runtime type not found')
      const config = record(ctx.body.config)
      const validated = record(
        await hub.call(
          text(connector.id),
          'runtime.validateConfig',
          { runtime: type, runtimeId: type, config },
          { signal: ctx.signal },
        ),
      )
      if (validated.ok === false || validated.valid === false)
        throw new ApiError(
          422,
          text(validated.message, 'invalid runtime config'),
        )
      const [count] = await db.query(
        'SELECT COUNT(*) count FROM device_runtimes WHERE connector_id=$1 AND runtime_type=$2',
        [connector.id, type],
      )
      if (
        provider.max_instances &&
        Number(count!.count) >= Number(provider.max_instances)
      )
        throw new ApiError(409, 'runtime instance limit reached')
      const id = identifier(type)
      const [row] = await db.query(
        "INSERT INTO device_runtimes(connector_id,runtime_id,runtime_type,name,name_key,config_json,active,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$7,$8,'stopped',$6,$6) RETURNING *",
        [
          connector.id,
          id,
          type,
          name,
          name.toLowerCase(),
          now,
          JSON.stringify(config),
          ctx.body.active === true ? 1 : 0,
        ],
      )
      if (ctx.body.active === true) {
        try {
          const result = record(
            await hub.call(
              text(connector.id),
              'runtime.start',
              { runtime: type, runtimeId: id, name, config },
              { signal: ctx.signal },
            ),
          )
          if (result.ok === false)
            throw new ApiError(
              502,
              text(result.message, 'runtime start failed'),
            )
          await db.query(
            "UPDATE device_runtimes SET status='running' WHERE connector_id=$1 AND runtime_id=$2",
            [connector.id, id],
          )
          row!.status = 'running'
        } catch (error) {
          await db.query(
            "UPDATE device_runtimes SET status='error' WHERE connector_id=$1 AND runtime_id=$2",
            [connector.id, id],
          )
          throw error
        }
      }
      await hub.changed(text(connector.id))
      return runtimeView({ ...provider, ...row! })
    },
    { permission: 'devices.manage', status: 201 },
  )
  router.add(
    'GET',
    '/connectors/{connector_id}/runtimes/{runtime_id}',
    async (ctx) => runtimeView(await runtime(ctx)),
    { permission: 'devices.read' },
  )
  router.add(
    'PATCH',
    '/connectors/{connector_id}/runtimes/{runtime_id}',
    async (ctx) => {
      const row = await runtime(ctx),
        name = requiredText(ctx.body.name, 'name', 128)
      await db.query(
        'UPDATE device_runtimes SET name=$3,name_key=$4,updated_at=$5 WHERE connector_id=$1 AND runtime_id=$2',
        [row.connector_id, row.runtime_id, name, name.toLowerCase(), utcNow()],
      )
      return runtimeView(await runtime(ctx))
    },
    { permission: 'devices.manage' },
  )
  for (const part of ['config', 'active'])
    router.add(
      'PUT',
      `/connectors/{connector_id}/runtimes/{runtime_id}/${part}`,
      async (ctx) => {
        const row = await runtime(ctx),
          connector = await own(ctx)
        if (connector.executor_kind === 'server-agent')
          throw new ApiError(409, 'managed runtime cannot be edited')
        if (part === 'config') {
          const config = record(ctx.body.config || ctx.body)
          await hub.call(
            text(row.connector_id),
            'runtime.validateConfig',
            { runtime: row.runtime_type, runtimeId: row.runtime_id, config },
            { signal: ctx.signal },
          )
          await db.query(
            'UPDATE device_runtimes SET config_json=$3,updated_at=$4 WHERE connector_id=$1 AND runtime_id=$2',
            [
              row.connector_id,
              row.runtime_id,
              JSON.stringify(config),
              utcNow(),
            ],
          )
          if (row.active) {
            await hub.call(text(row.connector_id), 'runtime.stop', {
              runtime: row.runtime_type,
              runtimeId: row.runtime_id,
            })
            await hub.call(text(row.connector_id), 'runtime.start', {
              runtime: row.runtime_type,
              runtimeId: row.runtime_id,
              name: row.name,
              config,
            })
          }
        } else {
          const active = ctx.body.active === true
          if (active && row.config_json === null)
            throw new ApiError(
              409,
              'runtime must be configured before activation',
            )
          await hub.call(
            text(row.connector_id),
            active ? 'runtime.start' : 'runtime.stop',
            {
              runtime: row.runtime_type,
              runtimeId: row.runtime_id,
              name: row.name,
              config: json(row.config_json, {}),
            },
            { signal: ctx.signal },
          )
          await db.query(
            'UPDATE device_runtimes SET active=$3,status=$4,updated_at=$5 WHERE connector_id=$1 AND runtime_id=$2',
            [
              row.connector_id,
              row.runtime_id,
              active ? 1 : 0,
              active ? 'running' : 'stopped',
              utcNow(),
            ],
          )
        }
        await hub.changed(text(row.connector_id))
        return runtimeView(await runtime(ctx))
      },
      { permission: 'devices.manage' },
    )
  router.add(
    'DELETE',
    '/connectors/{connector_id}/runtimes/{runtime_id}/config',
    async (ctx) => {
      const row = await runtime(ctx)
      if ((await own(ctx)).executor_kind === 'server-agent')
        throw new ApiError(409, 'managed runtime cannot be edited')
      await hub.call(text(row.connector_id), 'runtime.stop', {
        runtime: row.runtime_type,
        runtimeId: row.runtime_id,
      })
      await db.query(
        "UPDATE device_runtimes SET config_json=NULL,active=0,status='stopped',updated_at=$3 WHERE connector_id=$1 AND runtime_id=$2",
        [row.connector_id, row.runtime_id, utcNow()],
      )
      return runtimeView(await runtime(ctx))
    },
    { permission: 'devices.manage' },
  )
  for (const [route, method, field] of [
    ['capabilities', 'runtime.capabilities', 'capabilitySet'],
    ['catalogs/model', 'runtime.modelCatalog', 'catalog'],
    ['catalogs/permission', 'runtime.permissionCatalog', 'catalog'],
    ['commands', 'runtime.commands', 'commands'],
  ])
    router.add(
      'GET',
      `/connectors/{connector_id}/runtimes/{runtime_id}/${route}`,
      async (ctx) => {
        const row = await runtime(ctx)
        if (!row.active || row.config_json === null)
          throw new ApiError(409, 'runtime is not active')
        const result = record(
          await hub.call(
            text(row.connector_id),
            method!,
            {
              runtime: row.runtime_type,
              runtimeId: row.runtime_id,
              limit: 200,
            },
            { signal: ctx.signal, timeoutMs: 30_000 },
          ),
        )
        return {
          ...(route === 'capabilities'
            ? { connectorId: row.connector_id }
            : {}),
          [field!]: result[field!] ?? result,
          serverTime: utcNow(),
        }
      },
      { permission: 'devices.read' },
    )

  router.add(
    'POST',
    '/pairing/start',
    async (ctx) => {
      const id = identifier('pair'),
        code = String(randomInt(1000000)).padStart(6, '0'),
        now = utcNow(),
        expiresAt = new Date(
          Date.now() + integer(ctx.body.ttlSeconds, 300, 30, 900) * 1000,
        ).toISOString()
      await db.query(
        "INSERT INTO pairing_codes(id,code,status,server_url,expires_at,created_at) VALUES($1,$2,'pending',$3,$4,$5)",
        [id, code, ctx.body.serverUrl || null, expiresAt, now],
      )
      return { pairingId: id, code, expiresAt, serverTime: now }
    },
    { public: true },
  )
  router.add(
    'POST',
    '/pairing/claim',
    async (ctx) => {
      const code = requiredText(ctx.body.code, 'code', 6)
      const [pair] = await db.query(
        'SELECT * FROM pairing_codes WHERE code=$1 AND expires_at>$2',
        [code, utcNow()],
      )
      if (!pair) throw new ApiError(404, 'pairing code not found')
      if (pair.status !== 'pending')
        throw new ApiError(409, 'pairing already claimed')
      let result: Row
      if (ctx.body.connectorId) {
        const connector = await store.connector(
          text(ctx.body.connectorId),
          ctx.account!.userId,
        )
        if (
          hashToken(requiredText(ctx.body.connectorToken, 'connectorToken')) !==
          connector.token_hash
        )
          throw new ApiError(401, 'invalid connector token')
        result = {
          connector: connectorView(connector, hub.isOnline(text(connector.id))),
          connectorToken: ctx.body.connectorToken,
        }
      } else result = await store.createConnector(ctx.account!.userId, ctx.body)
      const changed = await db.query(
        "UPDATE pairing_codes SET status='claimed',connector_id=$2,connector_token=$3,claimed_at=$4 WHERE id=$1 AND status='pending' RETURNING id",
        [pair.id, record(result.connector).id, result.connectorToken, utcNow()],
      )
      if (!changed.length) throw new ApiError(409, 'pairing already claimed')
      return { status: 'claimed', connector: result.connector }
    },
    { permission: 'devices.manage' },
  )
  router.add(
    'POST',
    '/pairing/poll',
    async (ctx) => {
      return db.transaction(async (connection) => {
        const [pair] = await connection.query(
          'SELECT * FROM pairing_codes WHERE id=$1 FOR UPDATE',
          [requiredText(ctx.body.pairingId, 'pairingId')],
        )
        if (!pair) throw new ApiError(404, 'pairing id not found')
        if (text(pair.expires_at) < utcNow())
          return { status: 'expired', serverTime: utcNow() }
        if (pair.consumed_at)
          throw new ApiError(409, 'pairing already consumed')
        if (pair.status !== 'claimed')
          return { status: 'pending', serverTime: utcNow() }
        await connection.query(
          'UPDATE pairing_codes SET consumed_at=$2,connector_token=NULL WHERE id=$1',
          [pair.id, utcNow()],
        )
        return {
          status: 'claimed',
          config: {
            serverUrl: pair.server_url,
            connectorId: pair.connector_id,
            connectorToken: pair.connector_token,
          },
          serverTime: utcNow(),
        }
      })
    },
    { public: true },
  )
}
