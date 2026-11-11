/** 真实旧运行实例创建handler的配置拒绝/实例上限分支，SQL与RPC仅注入合成事实。 */
import { readFileSync } from 'node:fs'

type Row = Record<string, unknown>
type Handler = (context: Row) => Promise<unknown>
const legacy = new URL('../../../admin/server/', import.meta.url)
const {
  registerDeviceRoutes,
}: { registerDeviceRoutes: (router: object, hub: object) => void } =
  await import(new URL('devices/routes.ts', legacy).href)
const {
  ApiError,
}: { ApiError: new (...args: unknown[]) => Error & { status: number } } =
  await import(new URL('http/api-router.ts', legacy).href)

interface Input {
  validated: Row
  count: number
  maximum: number
}
async function probe(input: Input) {
  const handlers = new Map<string, Handler>()
  let validation: Row = {}
  let writes = 0
  const db = {
    query: async (sql: string) => {
      if (sql.includes('FROM connector_runtime_types'))
        return [{ max_instances: input.maximum }]
      if (sql.includes('COUNT(*)')) return [{ count: input.count }]
      writes += 1
      throw new Error('negative scenario must not write')
    },
  }
  registerDeviceRoutes(
    {
      add: (method: string, path: string, handler: Handler) =>
        handlers.set(`${method} ${path}`, handler),
    },
    {
      store: {
        db,
        connector: async () => ({
          id: 'synthetic-connector',
          executor_kind: 'desktop',
        }),
      },
      call: async (_connector: string, _method: string, params: Row) => {
        validation = params
        return input.validated
      },
    },
  )
  try {
    await handlers.get('POST /connectors/{connector_id}/runtimes')!({
      params: { connector_id: 'synthetic-connector' },
      account: { userId: 'synthetic-owner' },
      body: {
        runtimeType: 'dsh',
        name: '合成实例',
        config: { model: 'synthetic' },
      },
      signal: new AbortController().signal,
    })
    throw new Error('negative scenario succeeded')
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    delete validation.runtimeId
    delete validation.configRevision
    return { status: error.status, detail: error.message, validation, writes }
  }
}
const inputs: Input[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
