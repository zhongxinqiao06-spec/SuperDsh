/** 执行旧身份真实处理器/用例；仅数据库、邮件发送和密码计算端口使用合成替身。 */
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'

type Row = Record<string, unknown>
type Handler = (context: Row) => unknown | Promise<unknown>
interface IdentityProbe {
  createUser(body: Row): Promise<Row>
  getUser(): Promise<Row>
  passwordHash(): Promise<string>
  getSetting(name: string): Promise<string>
  settingsObject(): Promise<Row>
}
const { IdentityService } = await loadLegacy<{
  IdentityService: new (db: object, options: object) => IdentityProbe
}>('identity/service.ts')
const { registerIdentityRoutes } = await loadLegacy<{
  registerIdentityRoutes(router: object, identity: object): void
}>('identity/routes.ts')
const { AccountManagement, pageQuery } = await loadLegacy<{
  AccountManagement: new (identity: object) => {
    updateUser(actor: object, id: string, body: Row): Promise<unknown>
  }
  pageQuery(url: URL, fallback: number): Row
}>('management/accounts.ts')
const { EmailVerification } = await loadLegacy<{
  EmailVerification: { prototype: { issue(...args: unknown[]): Promise<void> } }
}>('identity/email.ts')
const { integer } = await loadLegacy<{
  integer(value: unknown, fallback: number, min: number, max: number): number
}>('http/api-router.ts')
EmailVerification.prototype.issue = async () => undefined
let current: Row = {}
let captured: Row = {}
const database = {
  async query(sql: string, args: unknown[] = []) {
    if (sql.includes('count(*)')) return [{ count: String(current.users || 0) }]
    if (sql.startsWith('SELECT id FROM users WHERE username='))
      return current.collision ? [{ id: 'existing-user' }] : []
    if (sql.startsWith('INSERT INTO users')) captured.username = args[1]
    if (sql.startsWith('UPDATE users SET avatar=')) captured.avatar = args[1]
    return []
  },
  async transaction<T>(callback: (connection: object) => Promise<T>) {
    return callback(database)
  },
}
const identity = new IdentityService(database, {
  secret: 'synthetic-identity-boundary-secret-more-than-32-characters',
  setupToken: 'synthetic-setup',
  setupTokenExpiresAt: '2030-01-01T00:00:00Z',
})
identity.passwordHash = async () => 'synthetic-hash'
identity.getUser = async () => captured
identity.getSetting = async () => 'false'
identity.settingsObject = async () => ({})
const management = new AccountManagement(identity)
const routes = new Map<string, Handler>()
registerIdentityRoutes(
  {
    add: (method: string, path: string, handler: Handler) =>
      routes.set(`${method} ${path}`, handler),
  },
  identity,
)
const cases: Row[] = JSON.parse(readFileSync(0, 'utf8'))
const observations = []
for (const item of cases) {
  current = item
  captured = {}
  const body = (item.body || {}) as Row
  try {
    let result: unknown
    if (item.kind === 'username') {
      result = await identity.createUser(body)
    } else if (item.kind === 'page') {
      result = pageQuery(
        new URL('http://synthetic.invalid/?' + String(item.query)),
        Number(item.fallback),
      )
    } else if (item.kind === 'session-page') {
      const query = new URLSearchParams(String(item.query))
      result = {
        page: integer(query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
        pageSize: integer(query.get('pageSize'), 200, 1, 200),
        search: (query.get('search') || '').toLowerCase(),
      }
    } else if (item.kind === 'password-patch') {
      result = await management.updateUser({}, 'target', body)
    } else {
      const method = item.kind === 'avatar' ? 'PUT' : 'POST'
      const path =
        item.kind === 'avatar'
          ? '/auth/me/avatar'
          : item.kind === 'authorize'
            ? '/oauth/authorize'
            : '/auth/email-code'
      const handler = routes.get(`${method} ${path}`)!
      await handler({
        body,
        request: { headers: {} },
        user: async () => ({ userId: 'synthetic-user', resetRequired: false }),
      })
      result = item.kind === 'avatar' ? captured : { accepted: true }
    }
    observations.push({ status: 200, body: result })
  } catch (error) {
    const failure = error as Error & { status?: number }
    observations.push({
      status: failure.status || 500,
      body: { detail: failure.message },
    })
  }
}
process.stdout.write(JSON.stringify(observations))
