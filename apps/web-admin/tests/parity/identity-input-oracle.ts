/** 旧显示名称规则与真实登录/挑战handler，仅数据库查询返回合成的空集合。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
type Handler = (context: Row) => unknown | Promise<unknown>
const { IdentityService, displayName } = await loadLegacy<{
  IdentityService: new (db: object, options: object) => object
  displayName: (value: unknown) => string
}>('identity/service.ts')
const { registerIdentityRoutes } = await loadLegacy<{
  registerIdentityRoutes: (router: object, identity: object) => void
}>('identity/routes.ts')
const identity = new IdentityService(
  { query: async () => [] },
  { secret: 'synthetic-identity-input-test-secret-with-enough-length' },
)
const routes = new Map<string, Handler>()
registerIdentityRoutes(
  {
    add: (method: string, path: string, handler: Handler) =>
      routes.set(`${method} ${path}`, handler),
  },
  identity,
)
const values: Row[] = JSON.parse(readFileSync(0, 'utf8'))
const result = []
for (const value of values) {
  try {
    const body =
      value.kind === 'display'
        ? { displayName: displayName(value.value) }
        : await routes.get(`POST /auth/${value.kind}`)!({ body: value.body })
    result.push({ status: 200, body })
  } catch (error) {
    const failure = error as Error & { status?: number }
    result.push({
      status: failure.status || 500,
      body: { detail: failure.message },
    })
  }
}
process.stdout.write(JSON.stringify(result))
