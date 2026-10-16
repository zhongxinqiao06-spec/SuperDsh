import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ApiError, requiredText, text, utcNow } from '../http/api-router.ts'
import type { Account } from '../http/api-router.ts'
import type {
  Database,
  Row,
  SqlConnection,
} from '../infrastructure/database.ts'
import { json } from '../infrastructure/database.ts'
import { workspaceIdentity } from './workspace.ts'

export const identifier = (prefix: string): string =>
  `${prefix}_${randomBytes(18).toString('base64url')}`
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
export const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {}
export const array = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(record) : []

export function requirePermission(account: Account, permission: string): void {
  if (
    account.disabled ||
    account.deletedAt ||
    account.resetRequired ||
    !account.permissions.includes(permission)
  )
    throw new ApiError(403, `permission required: ${permission}`)
}
export function connectorView(row: Row, online: boolean): Row {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    connectorKind: row.connector_kind,
    executorKind: row.executor_kind || 'desktop',
    deviceOs: row.device_os ?? null,
    status: row.connection_blocked_at
      ? 'offline'
      : online
        ? 'online'
        : 'offline',
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedAt: row.connection_blocked_at ?? null,
    blockedReason: row.connection_blocked_reason ?? null,
    version: row.connector_version ?? null,
  }
}
export function sessionView(row: Row, online: boolean): Row {
  const state =
    row.source_state === 'visible'
      ? 'available'
      : row.source_state === 'hidden'
        ? 'unavailable'
        : row.source_state || 'available'
  return {
    id: row.id,
    connectorId: row.connector_id,
    executorKind: row.executor_kind || 'desktop',
    projectId: row.project_id ?? null,
    connectorStatus:
      online && !row.connection_blocked_at ? 'online' : 'offline',
    runtime: row.runtime,
    runtimeId: row.runtime_id || row.runtime,
    runtimeType: row.runtime,
    runtimeName: row.runtime_name ?? null,
    runtimeTypeDisplayName: row.runtime_display_name ?? null,
    externalSessionId: row.external_session_id ?? null,
    agentDefinition: json(row.agent_definition_json, null),
    title: row.title ?? null,
    cwd: row.cwd ?? null,
    status: row.status,
    takeover: !!row.takeover,
    pinned: !!row.pinned,
    pinnedAt: row.pinned_at ?? null,
    archived: !!row.archived,
    archivedAt: row.archived_at ?? null,
    userArchived: !!row.archived,
    sourceAvailability: state,
    sourceAvailabilityReason: row.source_state_reason ?? null,
    sourceAvailabilityUpdatedAt: row.source_state_at ?? null,
    sourceObservationOrigin: row.source_observation_origin ?? null,
    archiveSource: row.archived
      ? state === 'archived'
        ? 'both'
        : 'user'
      : state === 'archived'
        ? 'runtime'
        : null,
    unread:
      Number(row.latest_turn_end_seq || 0) > Number(row.last_read_seq || 0),
    lastReadSeq: Number(row.last_read_seq || 0),
    latestTurnEndSeq: Number(row.latest_turn_end_seq || 0),
    lastSyncedAt: row.last_synced_at ?? null,
    sourceObservedAt: row.source_observed_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    lastItemAt: row.last_item_at ?? null,
    lastItemOrderSeq:
      row.last_item_order_seq == null ? null : Number(row.last_item_order_seq),
    sortAt: row.sort_at || row.updated_at,
    updatedSeq: Number(row.updated_seq),
  }
}
export function projectView(row: Row): Row {
  return {
    id: row.id,
    userId: row.user_id,
    connectorId: row.connector_id,
    name: row.name,
    workspacePath: row.workspace_path,
    manuallyCreated: !!row.manually_created,
    pinned: !!row.pinned,
    pinnedAt: row.pinned_at ?? null,
    activeSessionCount: Number(row.active_count || 0),
    sidebarSessionCounts: {
      active: Number(row.active_count || 0),
      archived: Number(row.archived_count || 0),
    },
    lastActivityAt: row.last_activity_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function runtimeView(row: Row): Row {
  return {
    connectorId: row.connector_id,
    runtimeId: row.runtime_id,
    runtimeType: row.runtime_type,
    name: row.name,
    displayName: row.name,
    typeDisplayName: row.display_name || row.runtime_type,
    present: !!row.present,
    available: !!row.available,
    reason: row.reason || null,
    discovery: json(row.discovery_json, {}),
    metadata: json(row.metadata_json, {}),
    schema: record(json(row.config_schema_json, {})).schema || null,
    uiSchema: json(row.ui_schema_json, {}),
    defaults: json(row.defaults_json, {}),
    capabilities: json(row.capabilities_json, {}),
    lastDiscoveredAt: row.last_discovered_at || row.updated_at,
    configured: row.config_json != null,
    config: json(row.config_json, null),
    active: !!row.active,
    status: row.status,
    error: json(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function encodeCursor(row: Row): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      p: Number(row.pinned || 0),
      s: row.sort_at || row.updated_at || '',
      o: Number(row.last_item_order_seq ?? -1),
      u: Number(row.updated_seq || 0),
      i: row.id,
    }),
  ).toString('base64url')
}
export function decodeCursor(value: string): {
  p: number
  s: string
  o: number
  u: number
  i: string
} {
  try {
    const cursor = record(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    )
    if (
      cursor.v !== 1 ||
      ![0, 1].includes(Number(cursor.p)) ||
      typeof cursor.s !== 'string' ||
      typeof cursor.i !== 'string' ||
      !cursor.i ||
      !Number.isSafeInteger(cursor.o) ||
      !Number.isSafeInteger(cursor.u)
    )
      throw new Error('invalid')
    return cursor as { p: number; s: string; o: number; u: number; i: string }
  } catch {
    throw new ApiError(400, 'invalid session cursor')
  }
}

const sessionColumns = `SELECT s.*, c.user_id, c.executor_kind, c.connection_blocked_at,
  r.name runtime_name, t.display_name runtime_display_name,
  (SELECT item_time FROM timeline_items WHERE session_id=s.id ORDER BY item_time DESC,order_seq DESC LIMIT 1) last_item_at,
  (SELECT order_seq FROM timeline_items WHERE session_id=s.id ORDER BY item_time DESC,order_seq DESC LIMIT 1) last_item_order_seq
  FROM sessions s JOIN connectors c ON c.id=s.connector_id
  LEFT JOIN device_runtimes r ON r.connector_id=c.id AND r.runtime_id=s.runtime_id
  LEFT JOIN connector_runtime_types t ON t.connector_id=c.id AND t.runtime_type=s.runtime`

/** SQL projections use the existing schema, preserving native IDs and history ownership. */
export class ConversationStore {
  readonly db: Database
  readonly online: (connectorId: string) => boolean
  constructor(db: Database, online: (connectorId: string) => boolean) {
    this.db = db
    this.online = online
  }

  async connector(id: string, userId?: string): Promise<Row> {
    const [row] = await this.db.query(
      'SELECT * FROM connectors WHERE id=$1 AND revoked=0' +
        (userId ? ' AND user_id=$2' : ''),
      userId ? [id, userId] : [id],
    )
    if (!row) throw new ApiError(404, 'connector not found')
    return row
  }
  async connectors(userId: string): Promise<Row[]> {
    return (
      await this.db.query(
        'SELECT * FROM connectors WHERE user_id=$1 AND revoked=0 ORDER BY updated_at DESC',
        [userId],
      )
    ).map((row) => connectorView(row, this.online(text(row.id))))
  }
  async createConnector(userId: string, body: Row): Promise<Row> {
    const installation = text(body.installationId)
    const id = installation
      ? `conn_${hashToken(`${userId}:${installation}`).slice(0, 24)}`
      : identifier('conn')
    const token = `agt_${randomBytes(32).toString('base64url')}`
    const now = utcNow()
    const kind = text(body.connectorKind, 'cli')
    if (!['cli', 'desktop'].includes(kind))
      throw new ApiError(422, 'invalid connectorKind')
    await this.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `connector-registration:${id}`,
      ])
      const existing = await db.query(
        'SELECT revoked FROM connectors WHERE id=$1 FOR UPDATE',
        [id],
      )
      if (existing[0]?.revoked)
        throw new ApiError(
          409,
          'installation was deleted; use a new installationId',
        )
      if (existing.length)
        await db.query(
          'UPDATE connectors SET token_hash=$2,token_prefix=$3,updated_at=$4 WHERE id=$1',
          [id, hashToken(token), token.slice(0, 12), now],
        )
      else
        await db.query(
          'INSERT INTO connectors(id,user_id,name,connector_kind,status,token_hash,token_prefix,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',
          [
            id,
            userId,
            text(body.name, 'SuperDsh Connector'),
            kind,
            'offline',
            hashToken(token),
            token.slice(0, 12),
            now,
          ],
        )
    })
    return {
      connector: connectorView(
        await this.connector(id, userId),
        this.online(id),
      ),
      connectorToken: token,
      tokenPrefix: token.slice(0, 12),
    }
  }
  async session(id: string, userId?: string): Promise<Row> {
    const [row] = await this.db.query(
      sessionColumns +
        ' WHERE s.id=$1 AND c.revoked=0' +
        (userId ? ' AND c.user_id=$2' : ''),
      userId ? [id, userId] : [id],
    )
    if (!row) throw new ApiError(404, 'session not found')
    return row
  }
  async sessions(
    userId: string,
    options: {
      archived?: boolean
      projectId?: string
      connectorId?: string
      cursor?: string
      limit?: number
      inventory?: boolean
    } = {},
  ): Promise<Row> {
    const values: unknown[] = [userId]
    let where = ' WHERE c.user_id=$1 AND c.revoked=0'
    const add = (sql: string, value: unknown) => {
      values.push(value)
      where += ` AND ${sql.replace('?', `$${values.length}`)}`
    }
    if (!options.inventory) add('s.archived=?', options.archived ? 1 : 0)
    if (options.projectId) add('s.project_id=?', options.projectId)
    if (options.connectorId) add('s.connector_id=?', options.connectorId)
    const cursor = options.cursor ? decodeCursor(options.cursor) : null
    let query = `SELECT * FROM (${sessionColumns}${where}) page`
    if (cursor) {
      const first = values.length + 1
      values.push(cursor.p, cursor.s, cursor.o, cursor.u, cursor.i)
      query += ` WHERE (pinned,COALESCE(sort_at,updated_at),COALESCE(last_item_order_seq,-1),updated_seq,id)<($${first},$${first + 1},$${first + 2},$${first + 3},$${first + 4})`
    }
    query +=
      ' ORDER BY pinned DESC,COALESCE(sort_at,updated_at) DESC,COALESCE(last_item_order_seq,-1) DESC,updated_seq DESC,id DESC'
    if (!options.inventory) {
      values.push((options.limit || 100) + 1)
      query += ` LIMIT $${values.length}`
    }
    const rows = await this.db.query(query, values)
    const limit = options.inventory ? rows.length : options.limit || 100
    const page = rows.slice(0, limit)
    return {
      sessions: page.map((row) =>
        sessionView(row, this.online(text(row.connector_id))),
      ),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && page.length ? encodeCursor(page.at(-1)!) : null,
      serverTime: utcNow(),
    }
  }
  async project(id: string, userId: string): Promise<Row> {
    const [row] = await this.db.query(
      'SELECT * FROM projects WHERE id=$1 AND user_id=$2',
      [id, userId],
    )
    if (!row) throw new ApiError(404, 'project not found')
    return row
  }
  async projects(userId: string): Promise<Row[]> {
    return (
      await this.db.query(
        `SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.project_id=p.id AND s.archived=0) active_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id=p.id AND s.archived=1) archived_count,
      (SELECT MAX(last_activity_at) FROM sessions s WHERE s.project_id=p.id) last_activity_at
      FROM projects p JOIN connectors c ON c.id=p.connector_id WHERE p.user_id=$1 AND c.revoked=0 ORDER BY p.pinned DESC,p.updated_at DESC`,
        [userId],
      )
    ).map(projectView)
  }
  async createProject(userId: string, body: Row): Promise<Row> {
    const connector = await this.connector(
      requiredText(body.connectorId, 'connectorId'),
      userId,
    )
    const workspace = requiredText(body.workspacePath, 'workspacePath').trim()
    const name = requiredText(body.name, 'name', 255).trim()
    if (connector.executor_kind === 'server-agent') {
      const [managed] = await this.db.query(
        'SELECT p.* FROM server_agents a JOIN projects p ON p.id=a.project_id AND p.user_id=a.owner_user_id AND p.connector_id=a.connector_id WHERE a.owner_user_id=$1 AND a.connector_id=$2',
        [userId, connector.id],
      )
      if (
        !managed ||
        workspaceIdentity(text(managed.workspace_path), connector.device_os)
          .key !== workspaceIdentity(workspace, connector.device_os).key
      )
        throw new ApiError(
          403,
          'server Agent workspace is managed by the platform',
        )
      return managed
    }
    const { key } = workspaceIdentity(workspace, connector.device_os)
    const existing = await this.db.query(
      'SELECT * FROM projects WHERE user_id=$1 AND connector_id=$2 AND workspace_key=$3',
      [userId, connector.id, key],
    )
    if (existing[0]) return existing[0]
    const now = utcNow()
    try {
      const [row] = await this.db.query(
        'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,manually_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',
        [
          identifier('prj'),
          userId,
          connector.id,
          name,
          workspace,
          key,
          body.manuallyCreated !== false,
          now,
        ],
      )
      return row!
    } catch (error) {
      if (record(error).code === '23505')
        throw new ApiError(409, 'project name already exists')
      throw error
    }
  }
  async createSession(
    userId: string,
    body: Row,
    options: { start?: boolean } = {},
  ): Promise<Row> {
    const connector = await this.connector(
      requiredText(body.connectorId, 'connectorId'),
      userId,
    )
    const project = await this.project(
      requiredText(body.projectId, 'projectId'),
      userId,
    )
    if (project.connector_id !== connector.id)
      throw new ApiError(422, 'project belongs to a different connector')
    const runtime = text(body.runtime, 'dsh'),
      runtimeId = text(body.runtimeId, runtime)
    let legacyManagedWorkspace = false
    if (connector.executor_kind === 'server-agent') {
      const [managed] = await this.db.query(
        'SELECT connector_id,project_id,runtime_id FROM server_agents WHERE owner_user_id=$1',
        [userId],
      )
      if (
        !managed ||
        managed.connector_id !== connector.id ||
        managed.project_id !== project.id ||
        managed.runtime_id !== runtimeId
      )
        throw new ApiError(
          403,
          'server Agent target is managed by the platform',
        )
      // Previously released native clients send the container's logical root.
      // Only this verified account/Connector/project binding may resolve it;
      // storage and RPC always use the actual managed project workspace below.
      legacyManagedWorkspace = body.cwd === '/workspace'
    }
    if (
      body.cwd &&
      !legacyManagedWorkspace &&
      workspaceIdentity(requiredText(body.cwd, 'cwd'), connector.device_os)
        .key !==
        workspaceIdentity(text(project.workspace_path), connector.device_os).key
    )
      throw new ApiError(422, 'cwd must match the selected project')
    const [deviceRuntime] = await this.db.query(
      'SELECT * FROM device_runtimes WHERE connector_id=$1 AND runtime_id=$2 AND runtime_type=$3',
      [connector.id, runtimeId, runtime],
    )
    if (!deviceRuntime || deviceRuntime.config_json === null)
      throw new ApiError(409, 'runtime is not configured')
    const selections = record(body.selections)
    const id = identifier('ses'),
      now = utcNow()
    const messageId = text(body.clientMessageId)
    const reservationKey = messageId
      ? `session-create:${hashToken(`${userId}:${connector.id}:${messageId}`)}`
      : null
    const fingerprint = hashToken(
      JSON.stringify([
        options.start ? 'start' : 'import',
        body.externalSessionId || null,
        project.id,
        runtimeId,
        body.content,
        selections,
        body.attachments || [],
        body.runtimeOptions || {},
        body.agentDefinitionId || null,
      ]),
    )
    const selected = await this.db.transaction(async (connection) => {
      if (reservationKey) {
        await connection.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [reservationKey],
        )
        const [existing] = await connection.query(
          'SELECT value FROM instance_settings WHERE key=$1',
          [reservationKey],
        )
        if (existing) {
          const previous = json<Row>(existing.value, {})
          // Older receipts used a different fingerprint and never persisted
          // acceptance. Neither an idle session nor a matching key proves it ran.
          if (
            !['accepted', 'rejected', 'pending'].includes(text(previous.state))
          )
            throw new ApiError(
              409,
              'session creation outcome is unknown; check the existing session before sending again',
              {
                code: 'session_create_outcome_unknown',
                sessionId: text(previous.sessionId),
              },
            )
          if (previous.fingerprint !== fingerprint)
            throw new ApiError(
              409,
              'clientMessageId was already used for a different request',
            )
          if (previous.state === 'rejected') {
            const failure = record(previous.failure)
            throw new ApiError(
              Number(failure.status) || 500,
              text(failure.detail, 'session creation was rejected'),
            )
          }
          if (previous.state !== 'accepted')
            throw new ApiError(
              409,
              'session creation is pending or its outcome is unknown; check the existing session before sending again',
              {
                code: 'session_create_outcome_unknown',
                sessionId: text(previous.sessionId),
              },
            )
          return {
            id: text(previous.sessionId),
            reused: true,
            connectorResult: previous.connectorResult ?? null,
          }
        }
      }
      await connection.query(
        `INSERT INTO sessions(id,connector_id,project_id,runtime,runtime_id,origin,external_session_id,title,cwd,status,takeover,model_selection_id,permission_selection_id,seq,updated_seq,created_at,updated_at,sort_at)
      VALUES($1,$2,$3,$4,$5,'platform',$6,$7,$8,'idle',1,$9,$10,0,0,$11,$11,$11)`,
        [
          id,
          connector.id,
          project.id,
          runtime,
          runtimeId,
          body.externalSessionId || null,
          body.title || null,
          project.workspace_path,
          selections.model || null,
          selections.permission || null,
          now,
        ],
      )
      if (reservationKey)
        await connection.query(
          'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3)',
          [
            reservationKey,
            JSON.stringify({
              sessionId: id,
              fingerprint,
              state: options.start ? 'pending' : 'accepted',
            }),
            now,
          ],
        )
      return { id, reused: false, connectorResult: null }
    })
    return {
      ...(await this.session(selected.id, userId)),
      reused: selected.reused,
      creationReceiptKey: reservationKey,
      connectorResult: selected.connectorResult,
    }
  }
  async finishSessionCreation(
    row: Row,
    outcome:
      | { state: 'accepted'; connectorResult: Row }
      | { state: 'rejected'; failure: ApiError },
  ): Promise<void> {
    if (!row.creationReceiptKey) return
    await this.db.transaction(async (connection) => {
      await connection.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [row.creationReceiptKey],
      )
      const [stored] = await connection.query(
        'SELECT value FROM instance_settings WHERE key=$1',
        [row.creationReceiptKey],
      )
      const receipt = json<Row>(stored?.value, {})
      if (receipt.sessionId !== row.id || receipt.state !== 'pending')
        throw new ApiError(409, 'session creation receipt changed')
      await connection.query(
        'UPDATE instance_settings SET value=$2,updated_at=$3 WHERE key=$1',
        [
          row.creationReceiptKey,
          JSON.stringify({
            ...receipt,
            state: outcome.state,
            ...(outcome.state === 'accepted'
              ? { connectorResult: outcome.connectorResult }
              : {
                  failure: {
                    status: outcome.failure.status,
                    detail: outcome.failure.message,
                  },
                }),
          }),
          utcNow(),
        ],
      )
    })
  }
  async timeline(
    id: string,
    options: {
      mode?: string
      afterSeq?: number
      beforeOrderSeq?: number
      limit?: number
    } = {},
  ): Promise<Row> {
    const mode = options.mode || 'latest',
      limit = options.limit || 100
    if (!['latest', 'changes', 'history'].includes(mode))
      throw new ApiError(422, 'invalid timeline mode')
    if (mode === 'history' && !options.beforeOrderSeq)
      throw new ApiError(422, 'beforeOrderSeq is required')
    const condition =
      mode === 'changes'
        ? ' AND updated_seq>$3'
        : mode === 'history'
          ? ' AND order_seq<$3'
          : ''
    const args: unknown[] = [id, limit + 1]
    if (condition)
      args.push(
        mode === 'changes' ? options.afterSeq || 0 : options.beforeOrderSeq,
      )
    // The session row is also locked by ingestion: read items and cursor at
    // one durable boundary so a concurrent append cannot advance an unseen cursor.
    const { rows, sequence } = await this.db.transaction(async (connection) => {
      const [session] = await connection.query(
        'SELECT seq FROM sessions WHERE id=$1 FOR SHARE',
        [id],
      )
      if (!session) throw new ApiError(404, 'session not found')
      const rows = await connection.query(
        `SELECT * FROM timeline_items WHERE session_id=$1${condition} ORDER BY ${mode === 'changes' ? 'updated_seq ASC,id ASC' : 'order_seq DESC,id DESC'} LIMIT $2`,
        args,
      )
      return { rows, sequence: Number(session.seq) }
    })
    const items = rows.slice(0, limit).map((row) => ({
      ...json<Row>(row.payload_json, {}),
      id: row.id,
      orderSeq: Number(row.order_seq),
      updatedSeq: Number(row.updated_seq),
    }))
    if (mode !== 'changes') items.reverse()
    return {
      sessionId: id,
      items,
      nextSeq: sequence,
      hasMore: rows.length > limit,
      serverTime: utcNow(),
    }
  }
  async ingestSession(
    connection: SqlConnection,
    connectorId: string,
    params: Row,
  ): Promise<Row> {
    const runtime = requiredText(
        params.runtime || params.runtimeType,
        'runtime',
      ),
      runtimeId = text(params.runtimeId, runtime)
    const incomingId = requiredText(params.sessionId || params.id, 'sessionId')
    const externalId = text(params.externalSessionId)
    const rows = await connection.query(
      'SELECT * FROM sessions WHERE id=$1 OR (connector_id=$2 AND runtime_id=$3 AND external_session_id=$4) ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE',
      [incomingId, connectorId, runtimeId, externalId || null],
    )
    if (rows[0]) {
      const row = rows[0]
      if (
        row.connector_id !== connectorId ||
        row.runtime !== runtime ||
        row.runtime_id !== runtimeId
      )
        throw new ApiError(409, 'session runtime binding mismatch')
      const workspace = text(params.cwd || row.cwd).trim()
      if (workspace) {
        const project = await this.ensureImportedProject(
          connection,
          connectorId,
          workspace,
          runtimeId,
        )
        await connection.query(
          'UPDATE sessions SET project_id=$2,cwd=$3 WHERE id=$1',
          [row.id, project.id, project.workspace_path],
        )
        row.project_id = project.id
        row.cwd = project.workspace_path
      }
      return row
    }
    const [connector] = await connection.query(
      'SELECT user_id FROM connectors WHERE id=$1 AND revoked=0',
      [connectorId],
    )
    if (!connector) throw new ApiError(404, 'connector not found')
    const now = utcNow(),
      id = incomingId
    let projectId: unknown = null
    let workspace = text(params.cwd).trim()
    if (params.cwd) {
      const project = await this.ensureImportedProject(
        connection,
        connectorId,
        workspace,
        runtimeId,
      )
      projectId = project.id
      workspace = text(project.workspace_path)
    }
    const [created] = await connection.query(
      `INSERT INTO sessions(id,connector_id,project_id,runtime,runtime_id,external_session_id,title,cwd,status,takeover,seq,updated_seq,created_at,updated_at,sort_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,0,$10,$10,$10) RETURNING *`,
      [
        id,
        connectorId,
        projectId,
        runtime,
        runtimeId,
        externalId || null,
        params.title || null,
        workspace || null,
        text(params.status, 'idle'),
        now,
      ],
    )
    return created!
  }
  private async ensureImportedProject(
    connection: SqlConnection,
    connectorId: string,
    workspace: string,
    runtimeId: string,
  ): Promise<Row> {
    const [connector] = await connection.query(
      'SELECT user_id,device_os,executor_kind FROM connectors WHERE id=$1 AND revoked=0 FOR SHARE',
      [connectorId],
    )
    if (!connector) throw new ApiError(404, 'connector not found')
    if (connector.executor_kind === 'server-agent') {
      const [managed] = await connection.query(
        'SELECT p.* FROM server_agents a JOIN projects p ON p.id=a.project_id AND p.user_id=a.owner_user_id AND p.connector_id=a.connector_id WHERE a.owner_user_id=$1 AND a.connector_id=$2 AND a.runtime_id=$3',
        [connector.user_id, connectorId, runtimeId],
      )
      if (
        !managed ||
        (workspace !== '/workspace' &&
          workspaceIdentity(workspace, connector.device_os).key !==
            workspaceIdentity(
              String(managed.workspace_path),
              connector.device_os,
            ).key)
      )
        throw new ApiError(
          403,
          'server Agent target is managed by the platform',
        )
      // Project identity belongs to the managed binding, even when an older
      // release projected another row with a differently normalized key.
      return managed
    }
    const identity = workspaceIdentity(workspace, connector.device_os)
    // Match the existing user-wide project-name uniqueness and serialize
    // automatic imports across this account's Connectors in one transaction.
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `project-import:${connector.user_id}`,
    ])
    const [existing] = await connection.query(
      'SELECT * FROM projects WHERE user_id=$1 AND connector_id=$2 AND workspace_key=$3',
      [connector.user_id, connectorId, identity.key],
    )
    if (existing) return { ...existing, workspace_path: identity.display }
    const names = new Set(
      (
        await connection.query('SELECT name FROM projects WHERE user_id=$1', [
          connector.user_id,
        ])
      ).map((row) => text(row.name)),
    )
    const base = identity.name.slice(0, 255)
    let name = base
    for (let suffix = 1; names.has(name); suffix++) {
      const ending = ` (${suffix})`
      name = `${base.slice(0, 255 - ending.length)}${ending}`
    }
    const [created] = await connection.query(
      'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,manually_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,false,$7,$7) RETURNING *',
      [
        identifier('proj'),
        connector.user_id,
        connectorId,
        name,
        identity.display,
        identity.key,
        utcNow(),
      ],
    )
    return created!
  }
  async upsertTimeline(
    db: SqlConnection,
    session: Row,
    input: Row,
  ): Promise<{ item: Row; sequence: number; changed: boolean }> {
    const id = requiredText(input.id, 'timeline item id'),
      sessionId = text(session.id)
    const [previous] = await db.query(
      'SELECT * FROM timeline_items WHERE session_id=$1 AND id=$2',
      [sessionId, id],
    )
    const clean: Row = { ...input, sessionId }
    delete clean.updatedSeq
    const old = previous ? json<Row>(previous.payload_json, {}) : null
    if (old) {
      delete old.updatedSeq
      if (input.orderSeq === undefined) clean.orderSeq = old.orderSeq
      if (input.revision === undefined) clean.revision = old.revision
    }
    if (old && isDeepStrictEqual(old, clean))
      return {
        item: { ...clean, updatedSeq: Number(previous!.updated_seq) },
        sequence: Number(session.seq),
        changed: false,
      }
    const [revision] = await db.query(
      'UPDATE sessions SET seq=seq+1,updated_seq=seq+1,updated_at=$2,last_activity_at=$2,sort_at=$2 WHERE id=$1 RETURNING seq',
      [sessionId, utcNow()],
    )
    const sequence = Number(revision!.seq),
      order = Number(previous?.order_seq ?? input.orderSeq ?? sequence)
    const item: Row = {
      ...clean,
      id,
      sessionId,
      orderSeq: order,
      updatedSeq: sequence,
    }
    await db.query(
      `INSERT INTO timeline_items(session_id,id,type,status,role,order_seq,updated_seq,item_time,payload_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(session_id,id) DO UPDATE SET type=EXCLUDED.type,status=EXCLUDED.status,role=EXCLUDED.role,updated_seq=EXCLUDED.updated_seq,item_time=EXCLUDED.item_time,payload_json=EXCLUDED.payload_json`,
      [
        sessionId,
        id,
        text(item.type, 'message'),
        text(item.status, 'completed'),
        item.role ?? null,
        order,
        sequence,
        item.createdAt || utcNow(),
        JSON.stringify(item),
      ],
    )
    session.seq = sequence
    return { item, sequence, changed: true }
  }
  state(row: Row): Row {
    return {
      sessionId: row.id,
      runtime: row.runtime,
      runtimeId: row.runtime_id,
      runtimeType: row.runtime,
      externalSessionId: row.external_session_id || null,
      status: row.status,
      selections: {
        ...(row.model_selection_id ? { model: row.model_selection_id } : {}),
        ...(row.permission_selection_id
          ? { permission: row.permission_selection_id }
          : {}),
      },
      statusReason: null,
      error: null,
      metadata: {},
      updatedSeq: Number(row.updated_seq),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
