/** 执行旧Store和列表路由，SQL传输为合成行；游标生成/验证保持真实旧实现。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
type Handler = (context: Row) => unknown | Promise<unknown>
const { ConversationStore, encodeCursor } = await loadLegacy<{
  ConversationStore: new (
    db: object,
    online: () => boolean,
  ) => { project: (id: string) => Promise<Row> }
  encodeCursor: (row: Row) => string
}>('conversations/store.ts')
const { registerConversationRoutes } = await loadLegacy<{
  registerConversationRoutes(router: object, hub: object): void
}>('conversations/routes.ts')
const { ApiError } = await loadLegacy<{
  ApiError: new (status: number, detail: string) => Error
}>('http/api-router.ts')
interface Probe {
  endpoint: 'sessions' | 'inventory' | 'project'
  query: Record<string, string>
  anchor?: number
  mutate?: 'delete' | 'move'
}
const key = (row: Row): (number | string)[] => [
  Number(row.pinned),
  String(row.sort_at || row.updated_at),
  Number(row.last_item_order_seq ?? -1),
  Number(row.updated_seq),
  String(row.id),
]
const compare = (
  left: (number | string)[],
  right: (number | string)[],
): number => {
  for (let index = 0; index < left.length; index++) {
    if (left[index]! < right[index]!) return -1
    if (left[index]! > right[index]!) return 1
  }
  return 0
}
async function probe(input: Probe): Promise<unknown> {
  let rows: Row[] = Array.from({ length: 126 }, (_, index) => ({
    id: `list-${String(index).padStart(3, '0')}`,
    connector_id: index === 125 ? 'revoked' : 'connector',
    user_id: 'owner',
    project_id: 'project',
    pinned: index % 7 === 0 ? 1 : 0,
    archived: index >= 120 ? 1 : 0,
    sort_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    last_item_order_seq: index % 5 ? index % 4 : null,
    seq: index % 3,
    updated_seq: index % 3,
    source_json: '{}',
    runtime: 'dsh',
    runtime_id: 'dsh',
  }))
  const params = { ...input.query }
  if (input.anchor !== undefined) {
    const anchor = rows
      .filter((row) => !row.archived && row.connector_id !== 'revoked')
      .sort((a, b) => -compare(key(a), key(b)))[input.anchor]!
    params.cursor = encodeCursor(anchor)
    if (input.mutate === 'delete')
      rows = rows.filter((row) => row.id !== anchor.id)
    if (input.mutate === 'move') {
      anchor.pinned = 1
      anchor.sort_at = '2030-01-01T00:00:00.000Z'
    }
  }
  const db = {
    query: async (sql: string, values: unknown[]): Promise<Row[]> => {
      let selected = rows.filter((row) => row.connector_id !== 'revoked')
      const archived = /s\.archived=\$(\d+)/u.exec(sql)
      if (archived)
        selected = selected.filter(
          (row) => row.archived === values[Number(archived[1]) - 1],
        )
      const project = /s\.project_id=\$(\d+)/u.exec(sql)
      if (project)
        selected = selected.filter(
          (row) => row.project_id === values[Number(project[1]) - 1],
        )
      const cursor = /<\(\$(\d+)/u.exec(sql)
      if (cursor)
        selected = selected.filter(
          (row) =>
            compare(
              key(row),
              values.slice(Number(cursor[1]) - 1, Number(cursor[1]) + 4) as (
                string | number
              )[],
            ) < 0,
        )
      selected.sort((a, b) => -compare(key(a), key(b)))
      const limit = / LIMIT \$(\d+)/u.exec(sql)
      return limit
        ? selected.slice(0, Number(values[Number(limit[1]) - 1]))
        : selected
    },
  }
  const store = new ConversationStore(db, () => false)
  store.project = async (id) => {
    if (id !== 'project') throw new ApiError(404, 'project not found')
    return { id }
  }
  const routes = new Map<string, Handler>()
  registerConversationRoutes(
    {
      add: (method: string, path: string, handler: Handler) =>
        routes.set(`${method} ${path}`, handler),
    },
    { store, isOnline: () => false },
  )
  const path =
    input.endpoint === 'inventory'
      ? '/sessions/list'
      : input.endpoint === 'project'
        ? '/projects/{project_id}/sessions'
        : '/sessions'
  try {
    const result = (await routes.get(`GET ${path}`)!({
      account: { userId: 'owner' },
      params: { project_id: 'project' },
      url: new URL('http://synthetic/?' + new URLSearchParams(params)),
    })) as Row
    return {
      status: 200,
      query: params,
      ids: (result.sessions as Row[]).map((row) => row.id),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }
  } catch (error) {
    const failure = error as Error & { status?: number }
    return {
      status: failure.status || 500,
      query: params,
      detail: failure.message,
    }
  }
}
const cases: Probe[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(cases.map(probe))))
