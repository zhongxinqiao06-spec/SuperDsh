/** 执行旧工作区规范化与项目真实 Store；数据库只替换为明确的合成行。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'

type Row = Record<string, unknown>
interface Probe {
  path: string
  deviceOs?: string
  manuallyCreated?: boolean
  managed?: boolean
}
const { workspaceIdentity } = await loadLegacy<{
  workspaceIdentity(path: string, os?: string): { key: string }
}>('conversations/workspace.ts')
const { ConversationStore } = await loadLegacy<{
  ConversationStore: new (
    db: object,
    online: () => boolean,
  ) => {
    createProject(owner: string, body: Row): Promise<Row>
  }
}>('conversations/store.ts')
async function probe(input: Probe): Promise<Row> {
  try {
    const key = workspaceIdentity(input.path, input.deviceOs).key
    const db = {
      query: async (sql: string, values: unknown[]): Promise<Row[]> => {
        if (sql.includes('FROM connectors'))
          return [
            {
              id: 'connector',
              user_id: 'owner',
              device_os: input.deviceOs,
              executor_kind: input.managed ? 'server-agent' : 'desktop',
            },
          ]
        if (sql.includes('FROM server_agents'))
          return [
            {
              id: 'managed',
              workspace_path: '/managed',
              manually_created: false,
            },
          ]
        if (sql.startsWith('SELECT * FROM projects')) return []
        if (sql.startsWith('INSERT INTO projects'))
          return [
            {
              name: values[3],
              workspace_path: values[4],
              manually_created: values[6],
            },
          ]
        throw new Error('unexpected synthetic SQL: ' + sql)
      },
    }
    const store = new ConversationStore(db, () => false)
    const row = await store.createProject('owner', {
      connectorId: 'connector',
      name: '合成项目',
      workspacePath: input.path,
      manuallyCreated: input.manuallyCreated,
    })
    return {
      status: 200,
      key,
      path: row.workspace_path,
      manuallyCreated: row.manually_created,
    }
  } catch (error) {
    const failure = error as Error & { status?: number }
    return { status: failure.status ?? 500, detail: failure.message }
  }
}
const inputs: Probe[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
