/** 旧源码真实路由和Store分页；只替换SQL传输，输入全部合成，不连接数据库。 */
import { readFileSync } from 'node:fs'

type Row = Record<string, unknown>
type Handler = (context: Row) => unknown | Promise<unknown>
interface Probe {
  endpoint: string
  query: Record<string, string>
  reset?: number
  concurrent?: boolean
}
interface Store {
  session: () => Promise<Row>
}
const legacy = new URL('../../../admin/server/', import.meta.url)
const {
  ConversationStore,
}: { ConversationStore: new (db: object, online: () => boolean) => Store } =
  await import(new URL('conversations/store.ts', legacy).href)
const {
  registerConversationRoutes,
}: { registerConversationRoutes: (router: object, hub: object) => void } =
  await import(new URL('conversations/routes.ts', legacy).href)

async function probe(input: Probe): Promise<unknown> {
  let reads = 0
  const session = {
    id: 'synthetic-session',
    user_id: 'synthetic-owner',
    connector_id: 'synthetic-connector',
    runtime: 'controlled',
    runtime_id: 'controlled',
    seq: 1000,
    updated_seq: 1000,
    timeline_reset_seq: input.reset || 0,
    status: 'idle',
    title: '查询差分',
    source_json: '{}',
    takeover: 0,
    pinned: 0,
    archived: 0,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
  }
  const items = Array.from({ length: 520 }, (_, index) => ({
    id: `item-${String(index + 1).padStart(3, '0')}`,
    order_seq: index + 1,
    updated_seq: index === 0 ? 900 : index + 1,
    payload_json: JSON.stringify({
      type: 'message',
      revision: index === 0 ? 2 : 1,
      content: `正文${index + 1}`,
      orderSeq: -1,
      updatedSeq: -1,
    }),
  }))
  const connection = {
    query: async (sql: string, values: unknown[]): Promise<Row[]> => {
      if (sql.includes('SELECT seq FROM sessions'))
        return [{ seq: session.seq }]
      if (sql.includes('FROM timeline_items')) {
        const changes = sql.includes('updated_seq>$3')
        let selected = items.filter((item) =>
          changes
            ? item.updated_seq > Number(values[2])
            : sql.includes('order_seq<$3')
              ? item.order_seq < Number(values[2])
              : true,
        )
        selected = selected.sort((a, b) =>
          changes
            ? a.updated_seq - b.updated_seq || a.id.localeCompare(b.id)
            : b.order_seq - a.order_seq || b.id.localeCompare(a.id),
        )
        return selected.slice(0, Number(values[1]))
      }
      if (
        sql.includes('connector_protocol_capabilities') ||
        sql.includes('connector_runtime_catalogs')
      )
        return []
      throw new Error(`Unexpected synthetic SQL: ${sql}`)
    },
  }
  const database = {
    ...connection,
    transaction: async (action: (connection: object) => Promise<unknown>) =>
      action(connection),
  }
  const store = new ConversationStore(database, () => false)
  store.session = async () => ({
    ...session,
    seq: input.concurrent && ++reads > 1 ? 1001 : 1000,
  })
  const routes = new Map<string, Handler>()
  registerConversationRoutes(
    {
      add: (method: string, path: string, handler: Handler) =>
        routes.set(`${method} ${path}`, handler),
    },
    {
      store,
      isOnline: () => false,
      liveState: new Map(),
      notices: new Map(),
    },
  )
  const handler = routes.get(`GET /sessions/{session_id}/${input.endpoint}`)
  if (!handler) throw new Error('Missing real legacy handler')
  try {
    return {
      status: 200,
      body: await handler({
        params: { session_id: session.id },
        account: { userId: session.user_id },
        url: new URL(
          `http://synthetic/sessions/${session.id}/${input.endpoint}?${new URLSearchParams(input.query)}`,
        ),
      }),
    }
  } catch (error) {
    const value = error as Error & { status?: number }
    return { status: value.status || 500, body: { detail: value.message } }
  }
}
const inputs: Probe[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
