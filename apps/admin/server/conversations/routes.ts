import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type { ApiContext, ApiRouter } from '../http/api-router.ts'
import { json } from '../infrastructure/database.ts'
import type { Row } from '../infrastructure/database.ts'
import type { ConnectorHub } from '../devices/connector-hub.ts'
import { eventEnvelope } from '../devices/connector-hub.ts'
import { array, identifier, projectView, record, sessionView } from './store.ts'
import type { BusinessAgentService } from '../agents/service.ts'

export interface ConversationFilePort {
  stage(userId: string, sessionId: string, files: Row[]): Promise<Row[]>
}
const rpcParams = (row: Row): Row => ({
  sessionId: row.id,
  runtime: row.runtime,
  runtimeId: row.runtime_id,
  externalSessionId: row.external_session_id || null,
})
export function registerConversationRoutes(
  router: ApiRouter,
  hub: ConnectorHub,
  files?: ConversationFilePort,
  business?: BusinessAgentService,
): void {
  const { store } = hub,
    db = store.db
  const session = (ctx: ApiContext) =>
    store.session(ctx.params.session_id!, ctx.account!.userId)
  const view = (row: Row) =>
    sessionView(row, hub.isOnline(text(row.connector_id)))
  const paged = (ctx: ApiContext) => ({
    archived: ctx.url.searchParams.get('archived') === 'true',
    cursor: ctx.url.searchParams.get('cursor') || undefined,
    limit: integer(ctx.url.searchParams.get('limit'), 100, 1, 100),
  })
  const publish = async (row: Row) => {
    const current = await store.session(text(row.id))
    hub.emit(text(row.id), Number(current.seq), 'session.meta.updated', {
      session: view(current),
    })
    await hub.changed(text(current.connector_id))
  }
  const call = async (
    row: Row,
    method: string,
    params: Row = {},
    signal?: AbortSignal,
  ) => {
    const mutation = [
      'session.send_message',
      'session.interrupt',
      'session.steer',
      'session.selections.update',
      'session.command.execute',
      'interaction.respond',
    ].includes(method)
    if (mutation) {
      if (!row.takeover)
        throw new ApiError(
          409,
          'session is read-only until takeover is enabled',
        )
      if (
        row.archived ||
        ['unavailable', 'deleted', 'missing'].includes(text(row.source_state))
      )
        throw new ApiError(409, 'source session is not available')
      const [runtime] = await db.query(
        'SELECT active,status,config_json FROM device_runtimes WHERE connector_id=$1 AND runtime_id=$2',
        [row.connector_id, row.runtime_id],
      )
      if (
        !runtime?.active ||
        runtime.config_json == null ||
        runtime.status !== 'running'
      )
        throw new ApiError(409, 'session runtime is not running')
      const observed = record(
        await hub.call(
          text(row.connector_id),
          'session.state',
          rpcParams(row),
          { signal, timeoutMs: 15000 },
        ),
      )
      const observedState = record(observed.state)
      if (observedState.sessionId && observedState.sessionId !== row.id)
        throw new ApiError(502, 'connector session binding mismatch')
      const status = text(
        (observedState.status
          ? observedState
          : hub.liveState.get(text(row.id)) || store.state(row)
        ).status,
        'idle',
      )
      if (
        method === 'session.send_message' &&
        !['idle', 'error'].includes(status)
      )
        throw new ApiError(409, `session is ${status}`)
      if (method === 'session.steer' && status !== 'running')
        throw new ApiError(409, 'session is not running')
    }
    if (mutation || method === 'session.commands') {
      const source = record(
        await hub.call(
          text(row.connector_id),
          'session.capabilities',
          rpcParams(row),
          { signal, timeoutMs: 15000 },
        ),
      )
      const projected = (
        await capabilitySets(row, record(source.capabilitySet || source))
      ).effective
      const ids =
        method === 'session.selections.update'
          ? Object.keys(record(params.selections))
              .filter((key) => ['model', 'permission'].includes(key))
              .map((key) => `catalog.${key}`)
          : [
              method === 'interaction.respond'
                ? 'session.interaction.approval'
                : ['session.command.execute', 'session.commands'].includes(
                      method,
                    )
                  ? 'session.commands'
                  : method,
            ]
      if (Array.isArray(params.attachments) && params.attachments.length)
        ids.push('runtime.attachment')
      for (const id of ids) {
        const capability = array(projected.capabilities).find(
          (entry) => entry.capabilityId === id,
        )
        if (
          !capability?.supported ||
          !capability.available ||
          !capability.allowed
        )
          throw new ApiError(409, `session capability is unavailable: ${id}`)
      }
    }
    return hub.call(
      text(row.connector_id),
      method,
      { ...params, ...rpcParams(row) },
      { signal, timeoutMs: 60_000 },
    )
  }
  async function catalogs(row: Row): Promise<Row> {
    const results = await Promise.allSettled([
      hub.call(
        text(row.connector_id),
        'runtime.modelCatalog',
        { runtime: row.runtime, runtimeId: row.runtime_id, limit: 200 },
        { timeoutMs: 5000 },
      ),
      hub.call(
        text(row.connector_id),
        'runtime.permissionCatalog',
        { runtime: row.runtime, runtimeId: row.runtime_id, limit: 200 },
        { timeoutMs: 5000 },
      ),
    ])
    const output: Row = {}
    for (const [i, result] of results.entries())
      if (result.status === 'fulfilled')
        output[i ? 'permission' : 'model'] =
          record(result.value).catalog || result.value
    return output
  }
  async function capabilitySets(
    row: Row,
    runtime?: Row,
  ): Promise<{ runtime: Row; effective: Row }> {
    const [stored] = await db.query(
      'SELECT capabilities_json FROM connector_protocol_capabilities WHERE connector_id=$1',
      [row.connector_id],
    )
    const [catalog] = await db.query(
      "SELECT catalog_json FROM connector_runtime_catalogs WHERE connector_id=$1 AND runtime_id=$2 AND catalog_type='capability'",
      [row.connector_id, row.runtime_id],
    )
    const source =
      runtime ||
      json<Row>(stored?.capabilities_json || catalog?.catalog_json, {
        revision: 0,
        capabilities: [],
      })
    const matching = array(source.capabilities).filter(
      (item) =>
        (!item.runtime || item.runtime === row.runtime) &&
        (!item.runtimeId || item.runtimeId === row.runtime_id) &&
        (!item.sessionId || item.sessionId === row.id),
    )
    const ids = [...new Set(matching.map((item) => text(item.capabilityId)))]
    const online = hub.isOnline(text(row.connector_id))
    return {
      runtime: source,
      effective: {
        revision: Math.max(
          Number(source.revision || 0),
          Number(row.updated_seq || 0),
        ),
        capabilities: ids.map((id) => {
          const capability = matching
            .filter((item) => item.capabilityId === id)
            .sort(
              (a, b) =>
                Number(!!b.sessionId) - Number(!!a.sessionId) ||
                Number(!!b.runtimeId) - Number(!!a.runtimeId),
            )[0]!
          return {
            ...capability,
            scope: 'session',
            runtime: row.runtime,
            runtimeId: row.runtime_id,
            sessionId: row.id,
            available:
              !!capability.supported && !!capability.available && online,
            allowed: capability.allowed !== false && !!row.takeover,
            unavailableReason: !capability.supported
              ? 'runtime_capability_unsupported'
              : !online
                ? 'connector_offline'
                : !row.takeover
                  ? 'session_not_taken_over'
                  : capability.unavailableReason || null,
          }
        }),
      },
    }
  }
  async function snapshot(row: Row, limit: number): Promise<Row> {
    const timeline = await store.timeline(text(row.id), { limit })
    let capabilities: Row | undefined,
      notices = [...(hub.notices.get(text(row.id))?.values() || [])]
    const available = hub.isOnline(text(row.connector_id))
    if (available) {
      const response = await Promise.allSettled([
        call(row, 'session.capabilities'),
        call(row, 'session.notices'),
      ])
      if (response[0]?.status === 'fulfilled')
        capabilities = record(
          record(response[0].value).capabilitySet || response[0].value,
        )
      if (response[1]?.status === 'fulfilled')
        notices = array(record(response[1].value).notices)
    }
    const projected = await capabilitySets(row, capabilities)
    return {
      session: view(row),
      state: hub.liveState.get(text(row.id)) || store.state(row),
      timeline: {
        items: timeline.items,
        nextSeq: timeline.nextSeq,
        hasMore: timeline.hasMore,
      },
      approvals: [],
      notices,
      runtimeCapabilities: projected.runtime,
      effectiveCapabilities: projected.effective,
      catalogs: available ? await catalogs(row) : {},
      eventCursor: `seq:${timeline.nextSeq}`,
      serverTime: utcNow(),
    }
  }
  router.add(
    'GET',
    '/projects',
    async (ctx) => ({
      projects: await store.projects(ctx.account!.userId),
      serverTime: utcNow(),
    }),
    { permission: 'projects.read' },
  )
  router.add(
    'POST',
    '/projects',
    async (ctx) => {
      const row = await store.createProject(ctx.account!.userId, ctx.body)
      await hub.changed(text(row.connector_id))
      return {
        project: projectView(row),
        attachedSessions: 0,
        serverTime: utcNow(),
      }
    },
    { permission: 'projects.manage' },
  )
  router.add(
    'PATCH',
    '/projects/{project_id}',
    async (ctx) => {
      const row = await store.project(
        ctx.params.project_id!,
        ctx.account!.userId,
      )
      await db.query(
        'UPDATE projects SET name=COALESCE($2,name),pinned=COALESCE($3,pinned),pinned_at=CASE WHEN $3=1 THEN $4 WHEN $3=0 THEN NULL ELSE pinned_at END,updated_at=$4 WHERE id=$1',
        [
          row.id,
          ctx.body.name === undefined
            ? null
            : requiredText(ctx.body.name, 'name', 255),
          typeof ctx.body.pinned === 'boolean'
            ? ctx.body.pinned
              ? 1
              : 0
            : null,
          utcNow(),
        ],
      )
      await hub.changed(text(row.connector_id))
      return {
        project: projectView(
          await store.project(text(row.id), ctx.account!.userId),
        ),
        serverTime: utcNow(),
      }
    },
    { permission: 'projects.manage' },
  )
  router.add(
    'DELETE',
    '/projects/{project_id}',
    async (ctx) => {
      const row = await store.project(
        ctx.params.project_id!,
        ctx.account!.userId,
      )
      const [managed] = await db.query(
        'SELECT owner_user_id FROM server_agents WHERE project_id=$1',
        [row.id],
      )
      if (managed)
        throw new ApiError(
          409,
          'server Agent workspace is managed by the platform',
        )
      const detached = await db.transaction(async (connection) => {
        const changed = await connection.query(
          'UPDATE sessions SET project_id=NULL WHERE project_id=$1 RETURNING id',
          [row.id],
        )
        await connection.query(
          'DELETE FROM projects WHERE id=$1 AND user_id=$2',
          [row.id, ctx.account!.userId],
        )
        return changed.length
      })
      await hub.changed(text(row.connector_id))
      return {
        projectId: row.id,
        detachedSessions: detached,
        serverTime: utcNow(),
      }
    },
    { permission: 'projects.manage' },
  )
  router.add(
    'GET',
    '/projects/{project_id}/sessions',
    async (ctx) => {
      await store.project(ctx.params.project_id!, ctx.account!.userId)
      return store.sessions(ctx.account!.userId, {
        ...paged(ctx),
        projectId: ctx.params.project_id,
      })
    },
    { permission: 'sessions.read' },
  )
  for (const scope of ['projects', 'connectors'])
    router.add(
      'POST',
      `/${scope}/{target_id}/sessions/archive-all`,
      async (ctx) => {
        const id = ctx.params.target_id!
        if (scope === 'projects') await store.project(id, ctx.account!.userId)
        else await store.connector(id, ctx.account!.userId)
        const rows = await db.query(
          `SELECT s.* FROM sessions s JOIN connectors c ON c.id=s.connector_id WHERE c.user_id=$1 AND s.${scope === 'projects' ? 'project_id' : 'connector_id'}=$2`,
          [ctx.account!.userId, id],
        )
        for (const row of rows)
          await db.query(
            'UPDATE sessions SET archived=$2,archived_at=$3,seq=seq+1,updated_seq=seq+1 WHERE id=$1',
            [
              row.id,
              ctx.body.archived === false ? 0 : 1,
              ctx.body.archived === false ? null : utcNow(),
            ],
          )
        return {
          sessions: await Promise.all(
            rows.map(async (row) =>
              view(await store.session(text(row.id), ctx.account!.userId)),
            ),
          ),
          affected: rows.length,
          serverTime: utcNow(),
        }
      },
      { permission: 'sessions.run' },
    )
  router.add(
    'GET',
    '/sessions',
    (ctx) => store.sessions(ctx.account!.userId, paged(ctx)),
    { permission: 'sessions.read' },
  )
  router.add(
    'GET',
    '/sessions/list',
    (ctx) => store.sessions(ctx.account!.userId, { inventory: true }),
    { permission: 'sessions.read' },
  )
  router.add(
    'POST',
    '/sessions',
    async (ctx) => {
      requiredText(
        ctx.body.externalSessionId,
        'externalSessionId; new sessions must use /sessions/create-and-start',
      )
      const row = await store.createSession(ctx.account!.userId, ctx.body)
      await publish(row)
      return { session: view(row), connectorResult: null }
    },
    { permission: 'sessions.run' },
  )
  router.add(
    'POST',
    '/sessions/create-and-start',
    async (ctx) => {
      const connectorId = requiredText(ctx.body.connectorId, 'connectorId')
      const target = await store.connector(connectorId, ctx.account!.userId)
      const selectedAgent = ctx.body.agentDefinitionId
        ? await business?.available(
            ctx.account!,
            requiredText(ctx.body.agentDefinitionId, 'agentDefinitionId'),
          )
        : undefined
      if (
        ctx.body.agentDefinitionId &&
        (!selectedAgent || target.executor_kind !== 'server-agent')
      )
        throw new ApiError(422, '业务智能体需要使用服务端 Agent')
      await hub.connectorAllowed(connectorId)
      if (!hub.isOnline(connectorId))
        throw new ApiError(409, 'connector is offline')
      const row = await store.createSession(ctx.account!.userId, ctx.body, {
        start: true,
      })
      const params: Row = { ...ctx.body, ...rpcParams(row), cwd: row.cwd }
      if (row.reused)
        return { session: view(row), connectorResult: row.connectorResult }
      let dispatched = false
      let rejected = false
      let result: Row
      try {
        if (selectedAgent && business) {
          await business.bind(
            ctx.account!,
            { ...row, executor_kind: target.executor_kind },
            selectedAgent,
          )
          row.agent_definition_json = JSON.stringify({
            id: selectedAgent.id,
            name: selectedAgent.name,
            version: selectedAgent.version,
          })
        }
        if (files && Array.isArray(ctx.body.attachments)) {
          const staged = await files.stage(
            ctx.account!.userId,
            text(row.id),
            array(ctx.body.attachments),
          )
          params.attachments = staged
          params.timelineAttachments = staged
        }
        await db.query(
          `INSERT INTO session_active_runs(session_id,runtime,runtime_id,status,params_json,started_at,updated_at) VALUES($1,$2,$3,'running',$4,$5,$5) ON CONFLICT(session_id) DO UPDATE SET params_json=EXCLUDED.params_json,status='running',updated_at=EXCLUDED.updated_at`,
          [
            row.id,
            row.runtime,
            row.runtime_id,
            JSON.stringify(params),
            utcNow(),
          ],
        )
        dispatched = true
        const rawResult = record(
          await hub.call(connectorId, 'session.create', params, {
            signal: ctx.signal,
          }),
        )
        if (rawResult.ok === false) {
          rejected = true
          const error = record(rawResult.error)
          throw new ApiError(
            422,
            text(
              rawResult.message || error.message,
              'runtime rejected session creation',
            ),
          )
        }
        result =
          rawResult.ok === true && rawResult.result
            ? record(rawResult.result)
            : rawResult
        if (
          (result.sessionId && result.sessionId !== row.id) ||
          (result.runtimeId && result.runtimeId !== row.runtime_id)
        )
          throw new ApiError(502, 'connector session binding mismatch')
        await db.query(
          'UPDATE sessions SET external_session_id=COALESCE($2,external_session_id),status=CASE WHEN seq=0 THEN $3 ELSE status END,seq=seq+1,updated_seq=seq+1 WHERE id=$1',
          [
            row.id,
            result.externalSessionId || null,
            text(result.status, 'running'),
          ],
        )
        await store.finishSessionCreation(row, {
          state: 'accepted',
          connectorResult: result,
        })
      } catch (error) {
        if (!dispatched || rejected) {
          await store.finishSessionCreation(row, {
            state: 'rejected',
            failure:
              error instanceof ApiError
                ? error
                : new ApiError(500, 'internal server error'),
          })
          await db.query(
            'DELETE FROM session_active_runs WHERE session_id=$1',
            [row.id],
          )
          await db.query("UPDATE sessions SET status='error' WHERE id=$1", [
            row.id,
          ])
        }
        // A disconnect after dispatch cannot establish whether Harness accepted
        // the task. Retain the pending receipt and projected state; never replay.
        await publish(row)
        if (dispatched && !rejected)
          throw new ApiError(
            409,
            'session creation outcome is unknown; check the existing session before sending again',
            { code: 'session_create_outcome_unknown', sessionId: text(row.id) },
          )
        throw error
      }
      await publish(row)
      return {
        session: view(await store.session(text(row.id), ctx.account!.userId)),
        connectorResult: result,
      }
    },
    { permission: 'sessions.run' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/meta',
    async (ctx) => ({
      session: view(await session(ctx)),
      serverTime: utcNow(),
    }),
    { permission: 'sessions.read' },
  )
  router.add(
    'PATCH',
    '/sessions/{session_id}/meta',
    async (ctx) => {
      const row = await session(ctx)
      await db.query(
        `UPDATE sessions SET title=COALESCE($2,title),pinned=COALESCE($3,pinned),pinned_at=CASE WHEN $3=1 THEN $5 WHEN $3=0 THEN NULL ELSE pinned_at END,
      archived=COALESCE($4,archived),archived_at=CASE WHEN $4=1 THEN $5 WHEN $4=0 THEN NULL ELSE archived_at END,updated_at=$5,seq=seq+1,updated_seq=seq+1 WHERE id=$1`,
        [
          row.id,
          ctx.body.title === undefined
            ? null
            : requiredText(ctx.body.title, 'title'),
          typeof ctx.body.pinned === 'boolean' ? Number(ctx.body.pinned) : null,
          typeof ctx.body.archived === 'boolean'
            ? Number(ctx.body.archived)
            : null,
          utcNow(),
        ],
      )
      await publish(row)
      return { session: view(await session(ctx)), serverTime: utcNow() }
    },
    { permission: 'sessions.run' },
  )
  for (const operation of ['archive', 'unarchive', 'read'])
    router.add(
      'POST',
      `/sessions/${operation}`,
      async (ctx) => {
        const ids = ctx.json
        if (
          !Array.isArray(ids) ||
          ids.length > 1000 ||
          ids.some((id) => typeof id !== 'string')
        )
          throw new ApiError(422, 'expected an array of session IDs')
        const rows = await Promise.all(
          ids.map((id) => store.session(id as string, ctx.account!.userId)),
        )
        for (const row of rows) {
          if (operation === 'read')
            await db.query(
              'UPDATE sessions SET last_read_seq=GREATEST(seq,latest_turn_end_seq) WHERE id=$1',
              [row.id],
            )
          else
            await db.query(
              'UPDATE sessions SET archived=$2,archived_at=$3,seq=seq+1,updated_seq=seq+1 WHERE id=$1',
              [
                row.id,
                operation === 'archive' ? 1 : 0,
                operation === 'archive' ? utcNow() : null,
              ],
            )
          await publish(row)
        }
        return {
          sessions: await Promise.all(
            rows.map(async (row) => view(await store.session(text(row.id)))),
          ),
          affected: rows.length,
          serverTime: utcNow(),
        }
      },
      { permission: 'sessions.run' },
    )
  router.add(
    'GET',
    '/sessions/{session_id}/timeline',
    async (ctx) => {
      const row = await session(ctx)
      return store.timeline(text(row.id), {
        mode: ctx.url.searchParams.get('mode') || 'latest',
        afterSeq: integer(ctx.url.searchParams.get('afterSeq'), 0),
        beforeOrderSeq: ctx.url.searchParams.has('beforeOrderSeq')
          ? integer(ctx.url.searchParams.get('beforeOrderSeq'), 1, 1)
          : undefined,
        limit: integer(ctx.url.searchParams.get('limit'), 100, 1, 500),
      })
    },
    { permission: 'sessions.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/snapshot',
    async (ctx) =>
      snapshot(
        await session(ctx),
        integer(ctx.url.searchParams.get('limit'), 100, 1, 500),
      ),
    { permission: 'sessions.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/events',
    async (ctx) => {
      const row = await session(ctx),
        raw =
          ctx.url.searchParams.get('after') ||
          ctx.url.searchParams.get('cursor') ||
          'seq:0'
      if (
        !/^seq:(0|[1-9]\d*)$/.test(raw) ||
        !Number.isSafeInteger(Number(raw.slice(4)))
      )
        throw new ApiError(422, 'invalid event cursor')
      const after = Number(raw.slice(4))
      if (
        after > Number(row.seq) ||
        after < Number(row.timeline_reset_seq || 0)
      )
        return {
          events: [],
          nextCursor: `seq:${row.seq}`,
          snapshotRequired: true,
          serverTime: utcNow(),
        }
      const result = await store.timeline(text(row.id), {
        mode: 'changes',
        afterSeq: Number(raw.slice(4)),
        limit: integer(ctx.url.searchParams.get('limit'), 100, 1, 500),
      })
      if (result.hasMore)
        return {
          events: [],
          nextCursor: `seq:${result.nextSeq}`,
          snapshotRequired: true,
          serverTime: utcNow(),
        }
      const current = await session(ctx)
      if (Number(current.seq) !== Number(row.seq))
        return {
          events: [],
          nextCursor: `seq:${current.seq}`,
          snapshotRequired: true,
          serverTime: utcNow(),
        }
      const events = array(result.items).map((item) =>
        eventEnvelope(
          text(row.id),
          Number(item.updatedSeq),
          Number(item.revision || 1) > 1
            ? 'timeline.item_updated'
            : 'timeline.item_created',
          { item },
        ),
      )
      if (
        after === Number(current.seq) ||
        after < Number(current.updated_seq)
      ) {
        events.push(
          eventEnvelope(
            text(current.id),
            Number(current.updated_seq),
            'session.meta.updated',
            { session: view(current) },
          ),
        )
        const live = hub.liveState.get(text(current.id))
        // State is a live projection, not a durable timeline item. Recovery
        // must restore it as well; session metadata alone cannot end a turn in
        // clients that correctly keep runtime state separate from navigation.
        // An older cached status must never override the committed row.
        const state =
          live &&
          live.status === current.status &&
          Number(live.updatedSeq) <= Number(current.updated_seq)
            ? { ...store.state(current), ...live }
            : store.state(current)
        events.push(
          eventEnvelope(
            text(current.id),
            Number(current.updated_seq),
            'runtime.state.updated',
            {
              state: {
                ...state,
                sessionId: current.id,
                updatedSeq: Number(current.updated_seq),
              },
            },
          ),
        )
        events.push(
          eventEnvelope(
            text(current.id),
            Number(current.updated_seq),
            'runtime.capability.updated',
            { capabilitySet: (await capabilitySets(current)).effective },
          ),
        )
      }
      events.sort(
        (a, b) =>
          Number(a.sequence) - Number(b.sequence) ||
          text(a.eventId).localeCompare(text(b.eventId)),
      )
      return {
        sessionId: row.id,
        events,
        nextCursor: `seq:${result.nextSeq}`,
        snapshotRequired: false,
        serverTime: utcNow(),
      }
    },
    { permission: 'sessions.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/runtime/state',
    async (ctx) => {
      const row = await session(ctx)
      let state = hub.liveState.get(text(row.id)) || store.state(row)
      if (hub.isOnline(text(row.connector_id))) {
        const result = record(await call(row, 'session.state', {}, ctx.signal))
        if (result.state) {
          state = {
            ...store.state(row),
            ...record(result.state),
            sessionId: row.id,
          }
          hub.liveState.set(text(row.id), state)
        }
      }
      return { state, serverTime: utcNow() }
    },
    { permission: 'sessions.read' },
  )
  for (const [route, method, field] of [
    ['capabilities', 'session.capabilities', 'capabilitySet'],
    ['catalogs/model', 'runtime.modelCatalog', 'catalog'],
    ['catalogs/permission', 'runtime.permissionCatalog', 'catalog'],
    ['commands', 'session.commands', 'commands'],
    ['notices', 'session.notices', 'notices'],
  ])
    router.add(
      'GET',
      `/sessions/{session_id}/runtime/${route}`,
      async (ctx) => {
        const row = await session(ctx),
          result = record(await call(row, method!, { limit: 200 }, ctx.signal))
        if (route === 'capabilities')
          return {
            capabilitySet: (
              await capabilitySets(row, record(result.capabilitySet || result))
            ).effective,
            serverTime: utcNow(),
          }
        return { [field!]: result[field!] ?? result, serverTime: utcNow() }
      },
      { permission: 'sessions.read' },
    )
  router.add(
    'PATCH',
    '/sessions/{session_id}/runtime/selections',
    async (ctx) => {
      const row = await session(ctx),
        selections = record(ctx.body.selections)
      const result = record(
        await call(
          row,
          'session.selections.update',
          { selections },
          ctx.signal,
        ),
      )
      if (result.ok === false)
        throw new ApiError(
          502,
          text(
            result.message || result.code,
            'runtime rejected selection update',
          ),
        )
      await db.query(
        'UPDATE sessions SET model_selection_id=COALESCE($2,model_selection_id),permission_selection_id=COALESCE($3,permission_selection_id),seq=seq+1,updated_seq=seq+1 WHERE id=$1',
        [row.id, selections.model || null, selections.permission || null],
      )
      await publish(row)
      return {
        ok: true,
        connectorResult: result,
        state: record(result.state || store.state(await session(ctx))),
        serverTime: utcNow(),
      }
    },
    { permission: 'sessions.run' },
  )
  for (const [route, method] of [
    ['messages', 'session.send_message'],
    ['interrupt', 'session.interrupt'],
    ['steer', 'session.steer'],
    ['commands', 'session.command.execute'],
  ])
    router.add(
      'POST',
      `/sessions/{session_id}/runtime/${route}`,
      async (ctx) => {
        const row = await session(ctx),
          params = { ...ctx.body }
        if (route === 'messages' && files && Array.isArray(params.attachments))
          params.attachments = await files.stage(
            ctx.account!.userId,
            text(row.id),
            array(params.attachments),
          )
        const result = await call(row, method!, params, ctx.signal)
        if (record(result).ok === false) {
          const error = record(record(result).error)
          return {
            ok: false,
            result: record(result).result ?? null,
            error: {
              code: text(record(result).code || error.code, 'runtime_rejected'),
              message: text(
                record(result).message || error.message,
                'runtime rejected the operation',
              ),
            },
          }
        }
        await publish(row)
        return route === 'commands'
          ? { ...record(result), serverTime: utcNow() }
          : { ok: true, result, error: null }
      },
      { permission: 'sessions.run' },
    )
  router.add(
    'POST',
    '/sessions/{session_id}/runtime/notices/{notice_id}/respond',
    async (ctx) => {
      const row = await session(ctx),
        noticeId = ctx.params.notice_id!,
        notice = hub.notices.get(text(row.id))?.get(noticeId)
      const context = record(
        notice?.context || record(notice?.interaction).context,
      )
      const result = await call(
        row,
        'interaction.respond',
        {
          noticeId,
          actionId: requiredText(ctx.body.actionId, 'actionId'),
          inputData: { ...context, ...record(ctx.body.input) },
        },
        ctx.signal,
      )
      await publish(row)
      const raw = record(result)
      return raw.ok === false
        ? {
            ok: false,
            result: raw.result ?? null,
            error: raw.error || {
              code: text(raw.code, 'interaction_rejected'),
              message: text(raw.message, 'interaction is no longer available'),
            },
          }
        : { ok: true, result, error: null }
    },
    { permission: 'sessions.run' },
  )
  router.add(
    'POST',
    '/sessions/{session_id}/sync',
    async (ctx) => ({
      ok: true,
      result: await call(await session(ctx), 'session.sync', {}, ctx.signal),
      error: null,
    }),
    { permission: 'sessions.run' },
  )
  for (const enabled of [true, false])
    router.add(
      enabled ? 'POST' : 'DELETE',
      '/sessions/{session_id}/takeover',
      async (ctx) => {
        const row = await session(ctx)
        await db.query(
          'UPDATE sessions SET takeover=$2,seq=seq+1,updated_seq=seq+1 WHERE id=$1',
          [row.id, enabled ? 1 : 0],
        )
        await publish(row)
        return { session: view(await session(ctx)) }
      },
      { permission: 'sessions.run' },
    )
  router.add(
    'POST',
    '/sessions/{session_id}/shares',
    async (ctx) => {
      const row = await session(ctx),
        scope = text(ctx.body.scope, 'session')
      if (!['session', 'message'].includes(scope))
        throw new ApiError(422, 'invalid share scope')
      const all = (
        await db.query(
          'SELECT payload_json FROM timeline_items WHERE session_id=$1 ORDER BY order_seq',
          [row.id],
        )
      ).map((item) => json<Row>(item.payload_json, {}))
      const ids = Array.isArray(ctx.body.itemIds) ? ctx.body.itemIds : []
      const items =
        scope === 'message' ? all.filter((item) => ids.includes(item.id)) : all
      if (
        !items.length ||
        (scope === 'message' &&
          (items.length !== ids.length ||
            items.some(
              (item) => item.type !== 'message' || item.role !== 'assistant',
            )))
      )
        throw new ApiError(
          422,
          'a reply share must contain existing assistant messages',
        )
      const allowed = new Set<string>()
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) for (const item of value) visit(item)
        else if (value && typeof value === 'object') {
          const item = record(value)
          if (typeof item.fileId === 'string') allowed.add(item.fileId)
          for (const nested of Object.values(item)) visit(nested)
        }
      }
      visit(items)
      const snapshot = {
          session: {
            id: row.id,
            title: row.title,
            runtime: row.runtime,
            runtimeName: row.runtime_name,
            cwd: row.cwd,
          },
          items,
        },
        id = identifier('share'),
        now = utcNow()
      await db.query(
        'INSERT INTO session_shares(id,user_id,session_id,scope,snapshot_json,allowed_file_ids_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          ctx.account!.userId,
          row.id,
          scope,
          JSON.stringify(snapshot),
          JSON.stringify([...allowed]),
          now,
        ],
      )
      const sharePath = `/share/${id}`
      return {
        shareId: id,
        sharePath,
        shareUrl: `${process.env.AGENT_SERVER_PUBLIC_ORIGIN || `http://${ctx.request.headers.host || 'localhost'}`}${sharePath}`,
        scope,
        createdAt: now,
      }
    },
    { permission: 'sessions.read', status: 201 },
  )
  router.add(
    'GET',
    '/public/shares/{share_id}',
    async (ctx) => {
      const [row] = await db.query(
        'SELECT s.* FROM session_shares s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.disabled=0 AND u.deleted_at IS NULL',
        [ctx.params.share_id],
      )
      if (!row) throw new ApiError(404, 'share not found')
      return {
        shareId: row.id,
        scope: row.scope,
        ...json<Row>(row.snapshot_json, {}),
        createdAt: row.created_at,
        serverTime: utcNow(),
      }
    },
    { public: true },
  )
}
