/** 只执行旧管理端真实处理器；数据库和设备通道均为内存边界，不连接真实账号。 */
import { readFileSync } from 'node:fs'
type Row = Record<string, unknown>
type ApiHandler = (context: Row) => unknown | Promise<unknown>
// 动态加载仍执行旧源码；明确测试边界，避免新前端检查器递归编译旧运行时依赖。
const legacy = new URL('../../../admin/server/', import.meta.url)
const {
  registerConversationRoutes,
}: {
  registerConversationRoutes: (router: object, hub: object) => void
} = await import(new URL('conversations/routes.ts', legacy).href)
const {
  runtimeFailureItems,
}: { runtimeFailureItems: (items: Row[]) => Row[] } = await import(
  new URL('conversations/runtime-failure.ts', legacy).href
)
const {
  ApiError,
}: { ApiError: new (...args: unknown[]) => Error & { status: number } } =
  await import(new URL('http/api-router.ts', legacy).href)
const {
  matchSkills,
}: {
  matchSkills: (
    skills: Row[],
    text: string,
    extensions: string[],
    policy?: { mode: 'fixed'; fixedSkillId: string },
  ) => unknown
} = await import(new URL('skills/matching.ts', legacy).href)

interface Probe {
  kind:
    | 'failure'
    | 'command'
    | 'matching'
    | 'share'
    | 'selection'
    | 'session-view'
    | 'metadata-notification'
  row?: Row
  params?: Row
  runtimeError?: boolean
  online?: boolean
  items?: Row[]
  skills?: Row[]
  text?: string
  extensions?: string[]
  fixedSkillId?: string
  takeover?: boolean
  archived?: boolean
  source?: string
  action?: string
  capabilities?: Row[]
  scope?: string
  itemIds?: string[]
  operation?: string
  arguments?: unknown[]
}

async function probe(input: Probe): Promise<unknown> {
  if (input.kind === 'metadata-notification') {
    const {
      ConnectorHub,
    }: {
      ConnectorHub: {
        prototype: {
          notify: (
            this: object,
            connector: string,
            method: string,
            value: Row,
          ) => Promise<void>
        }
      }
    } = await import(new URL('devices/connector-hub.ts', legacy).href)
    if (input.runtimeError) {
      let captured: Row | undefined
      await ConnectorHub.prototype.notify.call(
        {
          connectorAllowed: async () => undefined,
          notify: async (_connector: string, method: string, params: Row) => {
            captured = { method, params }
          },
        },
        'synthetic-connector',
        'runtime.error',
        input.params || {},
      )
      return captured
    }
    const row: Row = { ...input.row }
    const effects: Row[] = []
    const connection = {
      query: async (_sql: string, values: unknown[]) => {
        row.title = values[1] || row.title
        row.seq = Number(row.seq || 0) + 1
        row.updated_seq = row.seq
        row.updated_at = row.last_synced_at = values[4]
        return [row]
      },
    }
    await ConnectorHub.prototype.notify.call(
      {
        connectorAllowed: async () => undefined,
        store: {
          db: {
            transaction: async (
              work: (value: typeof connection) => Promise<void>,
            ) => work(connection),
          },
          ingestSession: async () => row,
          session: async () => row,
        },
        isOnline: () => input.online === true,
        emit: (
          sessionId: string,
          sequence: number,
          type: string,
          payload: Row,
        ) => effects.push({ sessionId, sequence, type, payload }),
        changed: async () => undefined,
      },
      String(row.connector_id),
      'session.updated',
      { sessionId: row.id, runtime: row.runtime, title: input.text },
    )
    return effects[0]
  }
  if (input.kind === 'session-view') {
    const { sessionView }: { sessionView: (row: Row, online: boolean) => Row } =
      await import(new URL('conversations/store.ts', legacy).href)
    return sessionView(input.row || {}, false)
  }
  if (input.kind === 'selection') {
    const module: Record<string, (...values: unknown[]) => unknown> =
      await import(
        new URL(
          '../../../admin/src/components/session/catalog-selection.ts',
          import.meta.url,
        ).href
      )
    const operation = module[input.operation || '']
    if (!operation) throw new Error('Unknown selection probe')
    return operation(...(input.arguments || []))
  }
  if (input.kind === 'failure') return runtimeFailureItems(input.items || [])
  if (input.kind === 'matching')
    return matchSkills(
      input.skills || [],
      input.text || '',
      input.extensions || [],
      input.fixedSkillId
        ? { mode: 'fixed', fixedSkillId: input.fixedSkillId }
        : undefined,
    )
  const routes = new Map<string, ApiHandler>()
  const row: Row = {
    id: 'synthetic-session',
    connector_id: 'synthetic-connector',
    runtime: 'dsh',
    runtime_id: 'dsh',
    takeover: input.takeover,
    archived: input.archived,
    source_state: input.source || 'available',
    status: 'idle',
    seq: 0,
  }
  const calls: string[] = []
  let share: Row | undefined
  const hub = {
    store: {
      db: {
        query: async (sql: string, args: unknown[] = []) => {
          if (sql.includes('SELECT payload_json FROM timeline_items'))
            return (input.items || []).map((item) => ({
              payload_json: JSON.stringify(item),
            }))
          if (sql.includes('INSERT INTO session_shares'))
            share = {
              items: (JSON.parse(String(args[4])) as Row).items,
              fileIds: JSON.parse(String(args[5])) as unknown,
            }
          return sql.includes('device_runtimes')
            ? [{ active: true, status: 'running', config_json: {} }]
            : []
        },
        lease: async () => ({ release: async () => undefined }),
      },
      session: async () => row,
      state: () => ({ sessionId: row.id, status: 'idle' }),
    },
    isOnline: () => true,
    liveState: new Map(),
    call: async (_: string, method: string) => {
      calls.push(method)
      if (method === 'session.state')
        return { state: { sessionId: row.id, status: 'idle' } }
      if (method === 'session.capabilities')
        return {
          capabilitySet: {
            capabilities: input.capabilities || [
              {
                capabilityId: 'session.interrupt',
                supported: true,
                available: true,
                allowed: true,
              },
            ],
          },
        }
      return { ok: true }
    },
    emit: () => undefined,
    changed: async () => undefined,
  }
  const router = {
    add: (method: string, path: string, handler: ApiHandler) => {
      routes.set(`${method} ${path}`, handler)
    },
  }
  registerConversationRoutes(router, hub)
  const handler = routes.get(
    input.kind === 'share'
      ? 'POST /sessions/{session_id}/shares'
      : `POST /sessions/{session_id}/runtime/${input.action || 'interrupt'}`,
  )!
  const context = {
    params: { session_id: String(row.id) },
    body:
      input.kind === 'share'
        ? { scope: input.scope, itemIds: input.itemIds }
        : {},
    request: { headers: { host: 'localhost' } },
    account: { userId: 'synthetic-owner' },
    signal: new AbortController().signal,
  }
  try {
    await handler(context)
    if (input.kind === 'share') return { status: 200, ...share }
    return {
      status: 200,
      dispatched: calls.includes(`session.${input.action || 'interrupt'}`),
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return input.kind === 'share'
      ? { status: error.status }
      : { status: error.status, dispatched: false }
  }
}

const inputs = JSON.parse(readFileSync(0, 'utf8')) as Probe[]
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
