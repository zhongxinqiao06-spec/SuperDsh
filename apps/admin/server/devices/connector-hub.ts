import { createHmac, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
  ApiError,
  bearer,
  object,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type { Account } from '../http/api-router.ts'
import type {
  Database,
  Row,
  SqlConnection,
} from '../infrastructure/database.ts'
import { json } from '../infrastructure/database.ts'
import {
  ConversationStore,
  array,
  hashToken,
  identifier,
  record,
  requirePermission,
  runtimeView,
  sessionView,
} from '../conversations/store.ts'

export interface LocalConnector {
  call(method: string, params: Row, signal?: AbortSignal): Promise<unknown>
  close?(): Promise<void> | void
}
export interface ConnectorHubOptions {
  database: Database
  secret: string
  authenticateToken(token: string): Promise<Account>
  getUser(userId: string): Promise<Account>
}
interface Connection {
  id: string
  transport: LocalConnector
  abort: AbortController
  pending: Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >
  ws?: WebSocket
  lane: Promise<void>
}
interface Ticket {
  token: string
  userId: string
  clientId: string
  scope: string
  expires: number
}
interface ClientSubscription {
  ws: WebSocket
  userId: string
  token: string
  permission: string
  connectorId?: string
}
export function eventEnvelope(
  sessionId: string,
  sequence: number,
  type: string,
  payload: Row,
): Row {
  return {
    protocolVersion: '1.0',
    eventId: `evt_${sequence}_${hashToken(JSON.stringify([type, payload])).slice(0, 12)}`,
    sequence,
    cursor: `seq:${sequence}`,
    type,
    sessionId,
    emittedAt: utcNow(),
    payload,
  }
}
const equal = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** One broker owns RPC, ingestion, subscriptions and per-connection cancellation. */
export class ConnectorHub {
  readonly options: ConnectorHubOptions
  readonly store: ConversationStore
  readonly events = new EventEmitter()
  readonly connections = new Map<string, Connection>()
  readonly tickets = new Map<string, Ticket>()
  readonly liveState = new Map<string, Row>()
  readonly notices = new Map<string, Map<string, Row>>()
  readonly websocketPaths = [
    '/api/v2/connector/ws',
    '/api/v2/dashboard/ws',
    '/api/v2/sessions/{session_id}/ws',
  ]
  readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  })
  readonly clients = new Set<ClientSubscription>()
  private checkTimer: NodeJS.Timeout
  constructor(options: ConnectorHubOptions) {
    this.options = options
    this.store = new ConversationStore(options.database, (id) =>
      this.isOnline(id),
    )
    this.events.setMaxListeners(0)
    this.checkTimer = setInterval(() => {
      void this.revalidate()
    }, 10_000)
    this.checkTimer.unref()
  }
  isOnline(id: string): boolean {
    return this.connections.has(id)
  }
  async connectorAllowed(id: string): Promise<Row> {
    const row = await this.store.connector(id)
    if (row.connection_blocked_at)
      throw new ApiError(403, 'connector connection is blocked')
    const account = await this.options.getUser(text(row.user_id))
    if (account.disabled || account.deletedAt || account.resetRequired)
      throw new ApiError(403, 'account is inactive')
    if (row.executor_kind === 'server-agent') {
      requirePermission(account, 'sessions.run')
      requirePermission(account, 'models.use')
    }
    return row
  }
  async authenticateConnector(
    token: string,
  ): Promise<{ id: string; userId: string; tokenHash: string }> {
    const [id, expires, signature] = token.split('.')
    if (
      !id ||
      !expires ||
      !signature ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Math.floor(Date.now() / 1000)
    )
      throw new ApiError(401, 'invalid connector access token')
    const row = await this.connectorAllowed(id)
    const expected = createHmac('sha256', this.options.secret)
      .update(`${id}:${expires}:${text(row.token_hash)}`)
      .digest('base64url')
    if (!equal(expected, signature))
      throw new ApiError(401, 'invalid connector access token')
    return { id, userId: text(row.user_id), tokenHash: text(row.token_hash) }
  }
  async exchangeConnector(authorization: string): Promise<Row> {
    const match = /^Connector ([^:]+):(.+)$/.exec(authorization)
    if (!match) throw new ApiError(401, 'expected Connector authorization')
    const row = await this.connectorAllowed(match[1]!)
    if (!equal(hashToken(match[2]!), text(row.token_hash)))
      throw new ApiError(401, 'invalid connector credential')
    const expires = Math.floor(Date.now() / 1000) + 900
    const signature = createHmac('sha256', this.options.secret)
      .update(`${row.id}:${expires}:${row.token_hash}`)
      .digest('base64url')
    return { accessToken: `${row.id}.${expires}.${signature}`, expiresIn: 900 }
  }
  async registerLocal(
    id: string,
    transport: LocalConnector,
  ): Promise<() => Promise<void>> {
    await this.connectorAllowed(id)
    if (this.connections.has(id))
      throw new ApiError(409, 'connector id already connected')
    const connection: Connection = {
      id: identifier('connection'),
      transport,
      abort: new AbortController(),
      pending: new Map(),
      lane: Promise.resolve(),
    }
    this.connections.set(id, connection)
    await this.store.db.query(
      "UPDATE connectors SET status='online',last_seen_at=$2,updated_at=$2,presence_connection_id=$3 WHERE id=$1",
      [id, utcNow(), connection.id],
    )
    await this.changed(id)
    return async () => {
      if (this.connections.get(id) === connection) await this.disconnect(id)
    }
  }
  async call(
    id: string,
    method: string,
    params: Row,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    await this.connectorAllowed(id)
    const connection = this.connections.get(id)
    if (!connection) throw new ApiError(409, 'connector is offline')
    const timeout = AbortSignal.timeout(options.timeoutMs || 60_000)
    const signal = AbortSignal.any([
      connection.abort.signal,
      timeout,
      ...(options.signal ? [options.signal] : []),
    ])
    if (signal.aborted) throw new ApiError(409, 'connector request cancelled')
    return new Promise((resolve, reject) => {
      const aborted = () =>
        reject(
          new ApiError(
            timeout.aborted ? 504 : 409,
            timeout.aborted
              ? 'connector request timed out'
              : 'connector disconnected or request cancelled',
          ),
        )
      signal.addEventListener('abort', aborted, { once: true })
      void connection.transport
        .call(method, params, signal)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', aborted))
    })
  }
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    connection.abort.abort()
    for (const pending of connection.pending.values())
      pending.reject(new ApiError(409, 'connector disconnected'))
    connection.pending.clear()
    connection.ws?.close(1008, 'connection closed')
    await connection.transport.close?.()
    await connection.lane.catch(() => undefined)
    await this.store.db.query(
      "UPDATE connectors SET status='offline',presence_connection_id=NULL,updated_at=$2 WHERE id=$1 AND presence_connection_id=$3",
      [id, utcNow(), connection.id],
    )
    await this.changed(id)
  }
  async disconnectUser(userId: string): Promise<void> {
    for (const client of this.clients)
      if (client.userId === userId)
        client.ws.close(1008, 'account authorization changed')
    for (const row of await this.store.db.query(
      'SELECT id FROM connectors WHERE user_id=$1',
      [userId],
    ))
      await this.disconnect(text(row.id))
    for (const [key, ticket] of this.tickets)
      if (ticket.userId === userId) this.tickets.delete(key)
  }
  async revalidateUser(userId: string): Promise<void> {
    for (const client of this.clients)
      if (client.userId === userId) {
        try {
          const account = await this.options.authenticateToken(client.token)
          requirePermission(account, client.permission)
          if (client.connectorId)
            await this.connectorAllowed(client.connectorId)
        } catch {
          client.ws.close(1008, 'authorization changed')
        }
      }
    for (const [key, ticket] of this.tickets)
      if (ticket.userId === userId) {
        try {
          const account = await this.options.authenticateToken(ticket.token)
          requirePermission(
            account,
            ticket.scope === 'dashboard' ? 'devices.read' : 'sessions.read',
          )
        } catch {
          this.tickets.delete(key)
        }
      }
    for (const row of await this.store.db.query(
      'SELECT id FROM connectors WHERE user_id=$1',
      [userId],
    )) {
      try {
        await this.connectorAllowed(text(row.id))
      } catch {
        await this.disconnect(text(row.id))
      }
    }
  }
  async changed(connectorId: string): Promise<void> {
    const [row] = await this.store.db.query(
      'SELECT user_id FROM connectors WHERE id=$1',
      [connectorId],
    )
    if (row) this.events.emit(`dashboard:${row.user_id}`)
  }
  emit(sessionId: string, sequence: number, type: string, payload: Row): void {
    this.events.emit(
      `session:${sessionId}`,
      eventEnvelope(sessionId, sequence, type, payload),
    )
  }
  private async updateSource(
    db: SqlConnection,
    row: Row,
    params: Row,
    now: string,
  ): Promise<Row> {
    const state = text(
      params.availability ||
        (typeof params.sourceState === 'string'
          ? params.sourceState
          : record(params.sourceState).availability),
      'available',
    )
    if (
      ![
        'available',
        'archived',
        'unavailable',
        'deleted',
        'missing',
        'unknown',
      ].includes(state)
    )
      throw new ApiError(422, 'invalid source state')
    const reason = params.reason || record(params.sourceState).reason || null
    const changed =
      row.source_state !== state || row.source_state_reason !== reason
    const sourceArchive =
      state === 'archived' &&
      [null, 'visible', 'available'].includes(
        row.source_state as string | null,
      ) &&
      !row.archived
    const [updated] = await db.query(
      `UPDATE sessions SET source_state=$2,source_state_at=CASE WHEN $7 THEN $3 ELSE source_state_at END,source_observed_at=$4,source_state_reason=$5,source_observation_origin=$6,archived=CASE WHEN $8 THEN 1 ELSE archived END,archived_at=CASE WHEN $8 THEN $3 ELSE archived_at END,seq=seq+CASE WHEN $7 THEN 1 ELSE 0 END,updated_seq=CASE WHEN $7 THEN seq+1 ELSE updated_seq END WHERE id=$1 RETURNING *`,
      [
        row.id,
        state,
        now,
        params.observedAt || record(params.sourceState).observedAt || now,
        reason,
        text(params.observationOrigin, 'notification'),
        changed,
        sourceArchive,
      ],
    )
    return updated!
  }
  async ingest(
    connectorId: string,
    payload: { notifications: Row[] } | Row,
  ): Promise<Row> {
    await this.connectorAllowed(connectorId)
    const notifications = array(payload.notifications)
    if (notifications.length > 10000)
      throw new ApiError(413, 'too many notifications')
    const rejected: Row[] = []
    let accepted = 0
    for (const [index, notification] of notifications.entries()) {
      try {
        await this.notify(
          connectorId,
          requiredText(notification.method, 'method'),
          record(notification.params),
        )
        accepted++
      } catch (error) {
        rejected.push({
          index,
          method: notification.method,
          code: 'notification_failed',
          message:
            error instanceof ApiError ? error.message : 'invalid notification',
          errorType: 'NotificationError',
        })
      }
    }
    return { accepted, rejected, serverTime: utcNow() }
  }
  async notify(
    connectorId: string,
    method: string,
    params: Row,
  ): Promise<void> {
    await this.connectorAllowed(connectorId)
    if (method === 'runtime.error') {
      await this.notify(connectorId, 'notice.upsert', {
        ...params,
        noticeId: text(params.noticeId, `runtime_error_${params.sessionId}`),
        type: 'notification',
        source: {
          runtime: params.runtime,
          component: 'runtime',
          operationId: params.operationId || null,
        },
        title: text(params.title, 'Runtime error'),
        message: text(params.message, 'The runtime reported an error.'),
        severity: 'error',
        status: text(params.status, 'open'),
        context: {
          error: {
            code: 'runtime_error',
            message: text(params.message, 'The runtime reported an error.'),
            details: params,
          },
          reason: 'runtime_error',
        },
      })
      return
    }
    if (method === 'connector.heartbeat') {
      await this.store.db.query(
        'UPDATE connectors SET last_seen_at=$2 WHERE id=$1',
        [connectorId, utcNow()],
      )
      return
    }
    if (method === 'connector.preferencesUpdated') {
      await this.store.db.query(
        'UPDATE connectors SET user_preferences=$2 WHERE id=$1',
        [connectorId, JSON.stringify(params)],
      )
      return
    }
    if (method.startsWith('terminal.') || method.startsWith('shell.task.')) {
      this.events.emit(`realtime:${connectorId}`, { method, params })
      return
    }
    if (method === 'runtime.statusChanged') {
      await this.store.db.query(
        'UPDATE device_runtimes SET status=$3,error_json=$4,updated_at=$5 WHERE connector_id=$1 AND runtime_id=$2',
        [
          connectorId,
          params.runtimeId,
          params.status,
          params.error ? JSON.stringify(params.error) : null,
          utcNow(),
        ],
      )
      await this.changed(connectorId)
      return
    }
    if (
      method === 'protocol.capabilitiesUpdated' ||
      (method === 'runtime.capability.updated' && !params.sessionId)
    ) {
      const incoming = record(params.capabilitySet || params)
      if (
        !Array.isArray(incoming.capabilities) ||
        !Number.isSafeInteger(Number(incoming.revision)) ||
        Number(incoming.revision) < 0
      )
        throw new ApiError(422, 'invalid capability set')
      await this.store.db.transaction(async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `capabilities:${connectorId}`,
        ])
        const [previous] = await db.query(
          'SELECT * FROM connector_protocol_capabilities WHERE connector_id=$1 FOR UPDATE',
          [connectorId],
        )
        let source = incoming
        if (method === 'runtime.capability.updated') {
          const current = json<Row>(previous?.capabilities_json, {})
          const capabilities = new Map<string, Row>()
          for (const item of [
            ...array(current.capabilities),
            ...array(incoming.capabilities),
          ])
            capabilities.set(
              JSON.stringify([
                item.capabilityId,
                item.runtime,
                item.runtimeId || null,
                item.scope,
                item.sessionId || null,
              ]),
              item,
            )
          source = {
            revision: Math.max(
              Number(previous?.revision || 0),
              Number(incoming.revision),
            ),
            capabilities: [...capabilities.values()],
          }
        }
        await db.query(
          `INSERT INTO connector_protocol_capabilities(connector_id,revision,capabilities_json,updated_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(connector_id) DO UPDATE SET revision=EXCLUDED.revision,capabilities_json=EXCLUDED.capabilities_json,updated_at=EXCLUDED.updated_at WHERE connector_protocol_capabilities.revision<=EXCLUDED.revision`,
          [
            connectorId,
            Number(source.revision || 0),
            JSON.stringify(source),
            utcNow(),
          ],
        )
      })
      for (const row of await this.store.db.query(
        'SELECT id,seq FROM sessions WHERE connector_id=$1',
        [connectorId],
      ))
        this.emit(text(row.id), Number(row.seq), 'session.refetch_required', {
          eventCursor: `seq:${row.seq}`,
        })
      return
    }
    if (
      [
        'catalog.model.update',
        'catalog.permission.update',
        'runtime.catalog.updated',
      ].includes(method) &&
      !params.sessionId
    ) {
      const catalog = record(params.catalog || params),
        runtime = text(params.runtime || params.runtimeType, 'dsh'),
        runtimeId = text(params.runtimeId, runtime),
        kind =
          method === 'runtime.catalog.updated'
            ? requiredText(params.catalogType, 'catalogType')
            : method.includes('.model.')
              ? 'model'
              : 'permission'
      if (!['model', 'permission'].includes(kind))
        throw new ApiError(422, 'invalid catalog type')
      await this.store.db.query(
        `INSERT INTO connector_runtime_catalogs(connector_id,runtime,runtime_id,catalog_type,revision,catalog_json,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(connector_id,runtime_id,catalog_type) DO UPDATE SET revision=EXCLUDED.revision,catalog_json=EXCLUDED.catalog_json,updated_at=EXCLUDED.updated_at WHERE connector_runtime_catalogs.revision<=EXCLUDED.revision`,
        [
          connectorId,
          runtime,
          runtimeId,
          kind,
          Number(catalog.revision || 0),
          JSON.stringify(catalog),
          utcNow(),
        ],
      )
      for (const session of await this.store.db.query(
        'SELECT id,seq FROM sessions WHERE connector_id=$1 AND runtime_id=$2',
        [connectorId, runtimeId],
      ))
        this.emit(
          text(session.id),
          Number(session.seq),
          'runtime.catalog.updated',
          { catalogType: kind, catalog },
        )
      return
    }
    if (method === 'session.inventory.begin') {
      const token = requiredText(params.scanToken, 'scanToken', 128)
      if (token.length < 16)
        throw new ApiError(422, 'invalid inventory scan token')
      await this.store.db.query(
        'UPDATE sessions SET source_scan_token=$4 WHERE connector_id=$1 AND runtime=$2 AND runtime_id=$3',
        [
          connectorId,
          params.runtime,
          params.runtimeId || params.runtime,
          token,
        ],
      )
      return
    }
    if (method === 'session.inventory.complete') {
      const token = requiredText(params.scanToken, 'scanToken', 128)
      if (
        token.length < 16 ||
        !Array.isArray(params.sessions) ||
        params.sessions.length > 10000 ||
        typeof params.complete !== 'boolean'
      )
        throw new ApiError(422, 'invalid session inventory')
      const entries = array(params.sessions)
      const observed = new Set<string>()
      for (const entry of entries) {
        const id = requiredText(entry.sessionId, 'sessionId')
        if (observed.has(id))
          throw new ApiError(422, 'duplicate inventory session')
        observed.add(id)
      }
      const changes = await this.store.db.transaction(async (db) => {
        const rows = await db.query(
          'SELECT * FROM sessions WHERE connector_id=$1 AND runtime=$2 AND runtime_id=$3 AND source_scan_token=$4 ORDER BY id FOR UPDATE',
          [
            connectorId,
            params.runtime,
            params.runtimeId || params.runtime,
            token,
          ],
        )
        const changed: Row[] = []
        for (const row of rows) {
          const entry = entries.find(
            (item) =>
              item.sessionId === row.id ||
              (item.externalSessionId &&
                item.externalSessionId === row.external_session_id),
          )
          if (!entry && !params.complete) continue
          const updated = await this.updateSource(
            db,
            row,
            entry
              ? { ...entry, observationOrigin: 'inventory' }
              : {
                  availability: 'missing',
                  reason: 'not returned by complete inventory',
                  observationOrigin: 'inventory',
                },
            utcNow(),
          )
          await db.query(
            'UPDATE sessions SET source_scan_token=NULL WHERE id=$1 AND source_scan_token=$2',
            [row.id, token],
          )
          if (updated.seq !== row.seq) changed.push(updated)
        }
        return changed
      })
      for (const row of changes)
        this.emit(text(row.id), Number(row.seq), 'session.meta.updated', {
          session: sessionView(row, this.isOnline(connectorId)),
        })
      await this.changed(connectorId)
      return
    }
    const supported = [
      'session.created',
      'session.updated',
      'session.upsert',
      'session.meta.upsert',
      'session.state.updated',
      'session.source.updated',
      'session.turnEnded',
      'session.capability.updated',
      'timeline.itemUpsert',
      'timeline.sync',
      'notice.upsert',
      'runtime.capability.updated',
      'runtime.catalog.updated',
    ]
    if (!supported.includes(method)) {
      if (
        [
          'approval.requested',
          'protocol.modelCatalogUpdated',
          'protocol.permissionCatalogUpdated',
        ].includes(method)
      )
        throw new ApiError(422, `unsupported notification: ${method}`)
      return
    }
    const source = record(record(params.item).source)
    const normalized: Row = {
      ...params,
      runtime: params.runtime || source.runtime,
      sessionId: params.sessionId || record(params.session).id,
    }
    if (params.session) Object.assign(normalized, record(params.session))
    const effects: {
      sessionId: string
      sequence: number
      type: string
      payload: Row
    }[] = []
    await this.store.db.transaction(async (db) => {
      const session = await this.store.ingestSession(
        db,
        connectorId,
        normalized,
      )
      const id = text(session.id),
        now = utcNow()
      if (method === 'timeline.itemUpsert' || method === 'timeline.sync') {
        const items =
          method === 'timeline.itemUpsert'
            ? [object(params.item)]
            : array(params.items)
        if (method === 'timeline.sync' && params.complete === true) {
          const deleted = await db.query(
            'DELETE FROM timeline_items WHERE session_id=$1 AND NOT(id=ANY($2::text[])) RETURNING id',
            [id, items.map((item) => item.id)],
          )
          if (deleted.length) {
            const [row] = await db.query(
              'UPDATE sessions SET seq=seq+1,updated_seq=seq+1,timeline_reset_seq=seq+1 WHERE id=$1 RETURNING seq',
              [id],
            )
            effects.push({
              sessionId: id,
              sequence: Number(row!.seq),
              type: 'session.refetch_required',
              payload: { eventCursor: `seq:${row!.seq}` },
            })
          }
        }
        for (const item of items) {
          const update = await this.store.upsertTimeline(db, session, item)
          if (update.changed)
            effects.push({
              sessionId: id,
              sequence: update.sequence,
              type:
                Number(update.item.revision || 1) > 1
                  ? 'timeline.item_updated'
                  : 'timeline.item_created',
              payload: { item: update.item },
            })
        }
        if (method === 'timeline.sync')
          await db.query(
            'UPDATE sessions SET last_synced_at=$2,source_observed_at=COALESCE($3,source_observed_at),last_read_seq=CASE WHEN $4 THEN seq ELSE last_read_seq END WHERE id=$1',
            [id, now, params.sourceObservedAt || null, effects.length > 0],
          )
      } else {
        if (method === 'session.state.updated') {
          const selections = record(params.selections)
          const [row] = await db.query(
            `UPDATE sessions SET status=$2,model_selection_id=COALESCE($3,model_selection_id),permission_selection_id=COALESCE($4,permission_selection_id),external_session_id=COALESCE($5,external_session_id),updated_at=$6,seq=seq+1,updated_seq=seq+1 WHERE id=$1 RETURNING *`,
            [
              id,
              text(params.status, 'idle'),
              selections.model ?? null,
              selections.permission ?? null,
              params.externalSessionId || null,
              now,
            ],
          )
          const state: Row = {
            ...this.store.state(row!),
            ...params,
            sessionId: id,
            updatedSeq: Number(row!.seq),
            updatedAt: now,
          }
          this.liveState.set(id, state)
          if (['idle', 'error'].includes(text(state.status)))
            await db.query(
              'DELETE FROM session_active_runs WHERE session_id=$1',
              [id],
            )
          else if (state.status === 'running')
            await db.query(
              "INSERT INTO session_active_runs(session_id,runtime,runtime_id,external_session_id,status,params_json,started_at,updated_at) VALUES($1,$2,$3,$4,'running','{}',$5,$5) ON CONFLICT(session_id) DO NOTHING",
              [
                id,
                session.runtime,
                session.runtime_id,
                session.external_session_id,
                now,
              ],
            )
          effects.push({
            sessionId: id,
            sequence: Number(row!.seq),
            type: 'runtime.state.updated',
            payload: { state },
          })
        } else if (method === 'session.turnEnded') {
          const [row] = await db.query(
            "UPDATE sessions SET status='idle',seq=seq+1,updated_seq=seq+1,latest_turn_end_seq=seq+1,updated_at=$2 WHERE id=$1 RETURNING *",
            [id, now],
          )
          await db.query(
            'DELETE FROM session_active_runs WHERE session_id=$1',
            [id],
          )
          effects.push({
            sessionId: id,
            sequence: Number(row!.seq),
            type: 'session.meta.updated',
            payload: { session: sessionView(row!, this.isOnline(connectorId)) },
          })
          this.liveState.set(id, this.store.state(row!))
          effects.push({
            sessionId: id,
            sequence: Number(row!.seq),
            type: 'runtime.state.updated',
            payload: { state: this.store.state(row!) },
          })
        } else if (method === 'session.source.updated') {
          const updated = await this.updateSource(db, session, params, now)
          effects.push({
            sessionId: id,
            sequence: Number(updated!.seq),
            type: 'session.meta.updated',
            payload: {
              session: sessionView(updated!, this.isOnline(connectorId)),
            },
          })
        } else if (method === 'notice.upsert') {
          const notice = record(params.notice || params)
          const notices = this.notices.get(id) || new Map<string, Row>()
          notices.set(
            requiredText(notice.noticeId || notice.id, 'notice id'),
            notice,
          )
          this.notices.set(id, notices)
          effects.push({
            sessionId: id,
            sequence: Number(session.seq),
            type: 'runtime.notice.updated',
            payload: { notice },
          })
        } else if (
          method.startsWith('runtime.') ||
          method === 'session.capability.updated'
        )
          effects.push({
            sessionId: id,
            sequence: Number(session.seq),
            type:
              method === 'session.capability.updated'
                ? 'runtime.capability.updated'
                : method,
            payload: params,
          })
        else {
          const [updated] = await db.query(
            'UPDATE sessions SET title=COALESCE($2,title),cwd=COALESCE($3,cwd),external_session_id=COALESCE($4,external_session_id),last_synced_at=$5,updated_at=$5,seq=seq+1,updated_seq=seq+1 WHERE id=$1 RETURNING *',
            [
              id,
              normalized.title || null,
              normalized.cwd ? session.cwd : null,
              normalized.externalSessionId || null,
              now,
            ],
          )
          effects.push({
            sessionId: id,
            sequence: Number(updated!.seq),
            type: 'session.meta.updated',
            payload: {
              session: sessionView(updated!, this.isOnline(connectorId)),
            },
          })
        }
      }
    })
    for (const effect of effects)
      this.emit(effect.sessionId, effect.sequence, effect.type, effect.payload)
    await this.changed(connectorId)
  }
  async discover(connectorId: string): Promise<void> {
    const response = record(
      await this.call(
        connectorId,
        'runtime.discover',
        {},
        { timeoutMs: 20_000 },
      ),
    )
    for (const descriptor of array(response.runtimeTypes)) {
      const type = requiredText(descriptor.runtimeType, 'runtimeType'),
        schema = record(descriptor.configSchema),
        now = utcNow()
      await this.store.db.query(
        `INSERT INTO connector_runtime_types(connector_id,runtime_type,implementation_type,display_name,description,present,available,reason,recommended,recommendation_rank,discovery_json,config_schema_json,ui_schema_json,defaults_json,capabilities_json,metadata_json,instance_policy,max_instances,last_discovered_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$18)
        ON CONFLICT(connector_id,runtime_type) DO UPDATE SET present=1,available=EXCLUDED.available,display_name=EXCLUDED.display_name,reason=EXCLUDED.reason,discovery_json=EXCLUDED.discovery_json,config_schema_json=EXCLUDED.config_schema_json,capabilities_json=EXCLUDED.capabilities_json,last_discovered_at=EXCLUDED.last_discovered_at`,
        [
          connectorId,
          type,
          descriptor.implementationType || type,
          descriptor.displayName || type,
          descriptor.description || null,
          descriptor.available === false ? 0 : 1,
          descriptor.reason || null,
          descriptor.recommended ? 1 : 0,
          descriptor.recommendationRank ?? null,
          JSON.stringify(descriptor),
          descriptor.configSchema
            ? JSON.stringify(descriptor.configSchema)
            : null,
          JSON.stringify(schema.uiSchema || {}),
          JSON.stringify(schema.defaults || {}),
          JSON.stringify(descriptor.capabilities || {}),
          JSON.stringify(descriptor.metadata || {}),
          descriptor.instancePolicy || 'single',
          descriptor.maxInstances || 1,
          now,
        ],
      )
      await this.store.db.query(
        `INSERT INTO device_runtimes(connector_id,runtime_id,runtime_type,name,name_key,config_json,active,status,created_at,updated_at) VALUES($1,$2,$2,$3,$4,NULL,0,'stopped',$5,$5) ON CONFLICT(connector_id,runtime_id) DO NOTHING`,
        [
          connectorId,
          type,
          descriptor.displayName || type,
          text(descriptor.displayName, type).toLowerCase(),
          now,
        ],
      )
    }
    for (const runtime of await this.store.db.query(
      'SELECT * FROM device_runtimes WHERE connector_id=$1 AND active=1 AND config_json IS NOT NULL',
      [connectorId],
    )) {
      try {
        await this.call(connectorId, 'runtime.start', {
          runtime: runtime.runtime_type,
          runtimeId: runtime.runtime_id,
          name: runtime.name,
          config: json(runtime.config_json, {}),
        })
        await this.store.db.query(
          "UPDATE device_runtimes SET status='running' WHERE connector_id=$1 AND runtime_id=$2",
          [connectorId, runtime.runtime_id],
        )
      } catch {
        await this.store.db.query(
          "UPDATE device_runtimes SET status='error' WHERE connector_id=$1 AND runtime_id=$2",
          [connectorId, runtime.runtime_id],
        )
      }
    }
    await this.changed(connectorId)
  }
  issueTicket(
    token: string,
    userId: string,
    clientId: string,
    scope: string,
  ): Row {
    for (const [key, item] of this.tickets)
      if (item.expires < Date.now()) this.tickets.delete(key)
    const ticket = identifier('wst'),
      expires = Date.now() + 60_000
    this.tickets.set(hashToken(ticket), {
      token,
      userId,
      clientId,
      scope,
      expires,
    })
    return {
      ticket,
      expiresAt: new Date(expires).toISOString(),
      serverTime: utcNow(),
    }
  }
  async consumeTicket(ticket: string, scope: string): Promise<Ticket> {
    const key = hashToken(ticket),
      value = this.tickets.get(key)
    this.tickets.delete(key)
    if (!value || value.expires < Date.now() || value.scope !== scope)
      throw new ApiError(401, 'invalid WebSocket ticket')
    const account = await this.options.authenticateToken(value.token)
    requirePermission(
      account,
      scope === 'dashboard' ? 'devices.read' : 'sessions.read',
    )
    if (account.userId !== value.userId)
      throw new ApiError(401, 'invalid ticket owner')
    return value
  }
  async dashboard(account: Account): Promise<Row> {
    const sessions = account.permissions.includes('sessions.read')
      ? (await this.store.sessions(account.userId, { inventory: true }))
          .sessions
      : []
    const runtimes = await this.store.db.query(
      'SELECT t.*,r.* FROM device_runtimes r JOIN connectors c ON c.id=r.connector_id LEFT JOIN connector_runtime_types t ON t.connector_id=r.connector_id AND t.runtime_type=r.runtime_type WHERE c.user_id=$1 AND c.revoked=0',
      [account.userId],
    )
    return {
      type: 'dashboard.snapshot',
      connectors: await this.store.connectors(account.userId),
      projects: account.permissions.includes('projects.read')
        ? await this.store.projects(account.userId)
        : [],
      sessions,
      runtimes: runtimes.map(runtimeView),
      sessionPages: {
        active: { hasMore: false, nextCursor: null },
        archived: { hasMore: false, nextCursor: null },
      },
      serverTime: utcNow(),
    }
  }
  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = new URL(request.url || '/', 'http://localhost')
    const sessionMatch = /^\/api\/v2\/sessions\/([^/]+)\/ws$/.exec(url.pathname)
    if (
      url.pathname !== '/api/v2/connector/ws' &&
      url.pathname !== '/api/v2/dashboard/ws' &&
      !sessionMatch
    )
      return false
    try {
      if (url.pathname === '/api/v2/connector/ws') {
        const identity = await this.authenticateConnector(bearer(request))
        if (this.connections.has(identity.id))
          throw new ApiError(409, 'connector already connected')
        this.server.handleUpgrade(request, socket, head, (ws) => {
          void this.attachSocket(identity.id, ws).catch(() =>
            ws.close(1011, 'connector setup failed'),
          )
        })
      } else {
        const scope = sessionMatch
          ? decodeURIComponent(sessionMatch[1]!)
          : 'dashboard'
        const ticket = await this.consumeTicket(
          url.searchParams.get('ticket') || '',
          scope,
        )
        if (scope !== 'dashboard')
          await this.store.session(scope, ticket.userId)
        this.server.handleUpgrade(request, socket, head, (ws) => {
          void this.attachClient(ws, ticket).catch(() =>
            ws.close(1008, 'authorization failed'),
          )
        })
      }
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error instanceof ApiError ? error.status : 500} Rejected\r\nConnection: close\r\n\r\n`,
      )
    }
    return true
  }
  private async attachSocket(id: string, ws: WebSocket): Promise<void> {
    const transport: LocalConnector = {
      call: (method, params, signal) =>
        new Promise((resolve, reject) => {
          const connection = this.connections.get(id)
          if (!connection || ws.readyState !== WebSocket.OPEN) {
            reject(new ApiError(409, 'connector offline'))
            return
          }
          const requestId = identifier('rpc')
          const abort = () => {
            connection.pending.delete(requestId)
            reject(new ApiError(409, 'request cancelled'))
          }
          connection.pending.set(requestId, {
            resolve: (value) => {
              signal?.removeEventListener('abort', abort)
              resolve(value)
            },
            reject: (error) => {
              signal?.removeEventListener('abort', abort)
              reject(error)
            },
          })
          signal?.addEventListener('abort', abort, { once: true })
          ws.send(
            JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
          )
        }),
    }
    const unregister = await this.registerLocal(id, transport)
    const connection = this.connections.get(id)!
    connection.ws = ws
    ws.on('message', (data) => {
      let message: Row
      try {
        message = object(JSON.parse(data.toString()))
      } catch {
        ws.close(1003, 'invalid JSON RPC')
        return
      }
      if (
        message.id &&
        (message.result !== undefined || message.error !== undefined)
      ) {
        const pending = connection.pending.get(text(message.id))
        connection.pending.delete(text(message.id))
        if (message.error)
          pending?.reject(
            new ApiError(
              502,
              text(record(message.error).message, 'connector request failed'),
            ),
          )
        else pending?.resolve(message.result)
      } else if (message.method) {
        connection.lane = connection.lane
          .then(async () => {
            if (this.connections.get(id) === connection)
              await this.notify(
                id,
                text(message.method),
                record(message.params),
              )
          })
          .catch(() => {
            ws.close(1008, 'invalid connector notification')
          })
      }
    })
    ws.on('close', () => {
      void unregister()
    })
    ws.on('error', () => {
      void unregister()
    })
    void this.discover(id).catch(() => undefined)
  }
  private async attachClient(ws: WebSocket, ticket: Ticket): Promise<void> {
    const client = {
      ws,
      userId: ticket.userId,
      token: ticket.token,
      permission:
        ticket.scope === 'dashboard' ? 'devices.read' : 'sessions.read',
    }
    this.clients.add(client)
    const topic =
      ticket.scope === 'dashboard'
        ? `dashboard:${ticket.userId}`
        : `session:${ticket.scope}`
    let lane = Promise.resolve()
    const delivered = new Set<string>()
    const liveProjection = new Map<string, string>()
    let pending = 0
    const send = async (event?: Row) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        ws.close(1013, 'slow client; reconnect to recover')
        return
      }
      try {
        const user = await this.options.authenticateToken(ticket.token)
        requirePermission(
          user,
          ticket.scope === 'dashboard' ? 'devices.read' : 'sessions.read',
        )
        const payload =
          ticket.scope === 'dashboard' ? await this.dashboard(user) : event
        if (payload && ws.readyState === WebSocket.OPEN) {
          const eventId = text(payload.eventId)
          const type = text(payload.type)
          const projection = [
            'runtime.state.updated',
            'runtime.capability.updated',
            'runtime.catalog.updated',
            'runtime.notice.updated',
          ].includes(type)
          const key = `${type}:${text(record(payload.payload).catalogType || record(record(payload.payload).notice).noticeId)}`
          if (
            eventId &&
            (projection
              ? liveProjection.get(key) === eventId
              : delivered.has(eventId))
          )
            return
          ws.send(JSON.stringify(payload))
          if (eventId) {
            if (projection) liveProjection.set(key, eventId)
            else {
              delivered.add(eventId)
              if (delivered.size > 512)
                delivered.delete(delivered.values().next().value!)
            }
          }
        }
      } catch {
        ws.close(1008, 'account authorization changed')
      }
    }
    const listener = (event?: Row) => {
      if (++pending > 2048) {
        ws.close(1013, 'slow client; reconnect to recover')
        return
      }
      lane = lane
        .then(() => send(event))
        .catch(() => ws.close(1011, 'stream failed'))
        .finally(() => {
          pending--
        })
    }
    lane = (async () => {
      if (ticket.scope === 'dashboard') await send()
      else {
        const row = await this.store.session(ticket.scope, ticket.userId)
        await send(
          eventEnvelope(ticket.scope, Number(row.seq), 'session.subscribed', {
            clientId: ticket.clientId,
            eventCursor: `seq:${row.seq}`,
          }),
        )
      }
    })()
    this.events.on(topic, listener)
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'keepalive', serverTime: utcNow() }))
    }, 15000)
    keepalive.unref()
    const close = () => {
      clearInterval(keepalive)
      this.events.off(topic, listener)
      this.clients.delete(client)
    }
    ws.once('close', close)
    ws.once('error', close)
    await lane
  }
  private async revalidate(): Promise<void> {
    for (const [id] of this.connections) {
      try {
        await this.connectorAllowed(id)
      } catch {
        await this.disconnect(id)
      }
    }
    for (const client of this.clients) {
      try {
        const account = await this.options.authenticateToken(client.token)
        requirePermission(account, client.permission)
        if (client.connectorId) await this.connectorAllowed(client.connectorId)
      } catch {
        client.ws.close(1008, 'authorization expired')
      }
    }
  }
  async close(): Promise<void> {
    clearInterval(this.checkTimer)
    for (const client of this.clients) client.ws.close(1001, 'server shutdown')
    await Promise.allSettled(
      [...this.connections.keys()].map((id) => this.disconnect(id)),
    )
    this.events.removeAllListeners()
    this.tickets.clear()
    this.server.close()
  }
}
