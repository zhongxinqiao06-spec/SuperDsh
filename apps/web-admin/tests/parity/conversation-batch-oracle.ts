/** 旧真实批量handler，SQL传输按语句记录合成行，验证数组、范围及写入顺序。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
type Handler = (context: Row) => unknown | Promise<unknown>
const { registerConversationRoutes } = await loadLegacy<{
  registerConversationRoutes(router: object, hub: object): void
}>('conversations/routes.ts')
const { ApiError } = await loadLegacy<{
  ApiError: new (status: number, detail: string) => Error
}>('http/api-router.ts')
interface Probe {
  operation: string
  value: unknown
  all?: boolean
  project?: boolean
  target?: string
}
async function probe(input: Probe): Promise<unknown> {
  const rows = Array.from({ length: 105 }, (_, index) => ({
    id: `session-${index}`,
    connector_id: 'connector',
    project_id: index < 103 ? 'project' : 'other',
    user_id: 'owner',
    seq: 40,
    updated_seq: 40,
    latest_turn_end_seq: 45,
    last_read_seq: 0,
    archived: index % 2,
    source_json: '{}',
    runtime: 'dsh',
    runtime_id: 'dsh',
    created_at: '2026-01-01T00:00:00Z',
  }))
  const find = (id: unknown): Row => {
    const row = rows.find((value) => value.id === id)
    if (!row) throw new ApiError(404, 'session not found')
    return row
  }
  const db = {
    query: async (sql: string, values: unknown[]): Promise<Row[]> => {
      if (sql.startsWith('SELECT s.*'))
        return rows.filter((row) =>
          sql.includes('s.project_id=')
            ? row.project_id === values[1]
            : row.connector_id === values[1],
        )
      const row = find(values[0])
      if (sql.includes('last_read_seq=GREATEST'))
        row.last_read_seq = Math.max(
          Number(row.seq),
          Number(row.latest_turn_end_seq),
        )
      else if (sql.includes('archived=$2')) {
        row.archived = values[1]
        row.archived_at = values[2]
        row.seq = Number(row.seq) + 1
        row.updated_seq = row.seq
      } else throw new Error('Unexpected SQL ' + sql)
      return []
    },
  }
  const routes = new Map<string, Handler>()
  const target = input.target || (input.project ? 'project' : 'connector')
  registerConversationRoutes(
    {
      add: (method: string, path: string, handler: Handler) =>
        routes.set(`${method} ${path}`, handler),
    },
    {
      store: {
        db,
        session: async (id: string) => ({ ...find(id) }),
        project: async (id: string) => {
          if (id !== 'project') throw new ApiError(404, 'project not found')
          return {}
        },
        connector: async (id: string) => {
          if (id !== 'connector') throw new ApiError(404, 'connector not found')
          return {}
        },
      },
      isOnline: () => false,
      emit: () => undefined,
      changed: async () => undefined,
    },
  )
  const path = input.all
    ? `/${input.project ? 'projects' : 'connectors'}/{target_id}/sessions/archive-all`
    : `/sessions/${input.operation}`
  try {
    const output = (await routes.get(`POST ${path}`)!({
      account: { userId: 'owner' },
      params: { target_id: target },
      json: input.value,
      body: input.value || {},
    })) as Row
    return {
      status: 200,
      affected: output.affected,
      sessions: (output.sessions as Row[]).map((row) => ({
        id: row.id,
        archived: row.archived,
        updatedSeq: row.updatedSeq,
        lastReadSeq: row.lastReadSeq,
      })),
      facts: rows.map((row) => ({
        id: row.id,
        archived: !!row.archived,
        sequence: row.seq,
        lastRead: row.last_read_seq,
      })),
    }
  } catch (error) {
    const failure = error as Error & { status?: number }
    return {
      status: failure.status || 500,
      detail: failure.message,
      facts: rows.map((row) => ({
        id: row.id,
        archived: !!row.archived,
        sequence: row.seq,
        lastRead: row.last_read_seq,
      })),
    }
  }
}
const inputs: Probe[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
