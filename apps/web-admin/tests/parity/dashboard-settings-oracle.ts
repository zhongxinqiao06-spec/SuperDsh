/** 执行冻结旧 DashboardService 与真实路由默认参数，数据库只记录合成写入。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
const { DashboardService, registerDashboardRoutes } = await loadLegacy<{
  DashboardService: {
    prototype: {
      updateSettings(this: object, body: Row): Promise<Row>
      overview(from: string, to: string, zone: string): Promise<Row>
      snapshot(date: string, zone: string): Promise<Row>
    }
  }
  registerDashboardRoutes(router: object, identity: object): void
}>('management/dashboard.ts')
DashboardService.prototype.overview = async (from, to, zone) => ({
  from,
  to,
  zone,
})
DashboardService.prototype.snapshot = async (date, zone) => ({ date, zone })
const routes = new Map<string, (context: object) => Promise<Row>>()
registerDashboardRoutes(
  {
    add(
      method: string,
      path: string,
      handler: (context: object) => Promise<Row>,
    ) {
      routes.set(method + ' ' + path, handler)
    },
  },
  {},
)
async function observe(input: Row) {
  try {
    if (input.query) {
      const query = input.query as Record<string, string>
      const handler = routes.get('GET /admin/dashboard/overview')!
      return {
        status: 200,
        value: await handler({
          url: new URL('http://localhost/?' + new URLSearchParams(query)),
        }),
      }
    }
    let writes = 0
    const value = await DashboardService.prototype.updateSettings.call(
      {
        settings: async () => ({ value: input.current }),
        identity: {
          db: {
            query: async () => {
              writes++
              return []
            },
          },
        },
      },
      input.body as Row,
    )
    return { status: 200, value, writes }
  } catch (error) {
    const failure = error as Error & { status?: number }
    return { status: failure.status ?? 500, detail: failure.message }
  }
}
const inputs: Row[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(observe))))
