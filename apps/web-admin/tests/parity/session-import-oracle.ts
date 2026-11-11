/** 运行旧导入handler与Store，合成SQL只负责存取，不重写校验/幂等算法。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
type Handler = (context: Row) => Promise<Row>
const { ConversationStore } = await loadLegacy<{
  ConversationStore: new (
    db: object,
    online: () => boolean,
  ) => { session(id: string): Promise<Row> }
}>('conversations/store.ts')
const { registerConversationRoutes } = await loadLegacy<{
  registerConversationRoutes(router: object, hub: object): void
}>('conversations/routes.ts')
interface Probe {
  bodies: Row[]
  configured?: boolean
  native?: boolean
}
async function probe(input: Probe): Promise<Row[]> {
  const sessions = new Map<string, Row>(),
    receipts = new Map<string, unknown>()
  const db = {
    query: async (sql: string, values: unknown[]): Promise<Row[]> => {
      if (sql.includes('FROM connectors'))
        return [
          {
            id: values[0],
            executor_kind: input.native ? 'server-agent' : 'desktop',
            device_os: 'linux',
          },
        ]
      if (sql.includes('FROM projects'))
        return values[0] === 'foreign'
          ? []
          : [
              {
                id: values[0],
                connector_id:
                  values[0] === 'project-other' ? 'other' : 'connector',
                workspace_path: '/synthetic',
              },
            ]
      if (sql.includes('FROM server_agents'))
        return [
          {
            connector_id: 'connector',
            project_id: 'project',
            runtime_id: 'dsh',
          },
        ]
      if (sql.includes('FROM device_runtimes'))
        return input.configured === false ? [] : [{ config_json: '{}' }]
      if (sql.includes('pg_advisory_xact_lock')) return []
      if (sql.startsWith('SELECT value FROM instance_settings'))
        return receipts.has(String(values[0]))
          ? [{ value: receipts.get(String(values[0])) }]
          : []
      if (sql.startsWith('INSERT INTO instance_settings')) {
        receipts.set(String(values[0]), values[1])
        return []
      }
      if (sql.startsWith('INSERT INTO sessions')) {
        const row = {
          id: values[0],
          connector_id: values[1],
          project_id: values[2],
          runtime: values[3],
          runtime_id: values[4],
          external_session_id: values[5],
          title: values[6],
          cwd: values[7],
          seq: 0,
          updated_seq: 0,
          takeover: 1,
          created_at: values[10],
          updated_at: values[10],
        }
        sessions.set(String(values[0]), row)
        return []
      }
      throw new Error('unexpected import SQL ' + sql)
    },
    transaction: async <T>(
      operation: (connection: object) => Promise<T>,
    ): Promise<T> => operation(db),
  }
  const store = new ConversationStore(db, () => false)
  store.session = async (id) => sessions.get(id)!
  const routes = new Map<string, Handler>()
  registerConversationRoutes(
    {
      add: (method: string, path: string, handler: Handler) =>
        routes.set(method + ' ' + path, handler),
    },
    { store, isOnline: () => false, emit: () => {}, changed: async () => {} },
  )
  const output: Row[] = []
  for (const body of input.bodies) {
    try {
      const result = await routes.get('POST /sessions')!({
        account: { userId: 'owner' },
        body,
      })
      const session = result.session as Row
      output.push({
        status: 200,
        externalSessionId: session.externalSessionId,
        cwd: session.cwd,
        connectorResult: result.connectorResult,
        count: sessions.size,
      })
    } catch (error) {
      const failure = error as Error & { status?: number }
      output.push({
        status: failure.status ?? 500,
        detail: failure.message,
        count: sessions.size,
      })
    }
  }
  return output
}
const inputs: Probe[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
