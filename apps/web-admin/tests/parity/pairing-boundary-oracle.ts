/** 运行旧真实配对handler，SQL与设备行由合成事实注入，不连接产品数据库。 */
import { readFileSync } from 'node:fs'

const { registerDeviceRoutes } =
  await import('../../../admin/server/devices/routes.ts')
const { ApiError } = await import('../../../admin/server/http/api-router.ts')
const { hashToken } =
  await import('../../../admin/server/conversations/store.ts')
type Row = Record<string, unknown>
type Handler = (context: Row) => Promise<unknown>

async function probe(scenario: string) {
  const handlers = new Map<string, Handler>()
  const poll = scenario.startsWith('poll-')
  const expired = scenario.includes('expired')
  const pair: Row = {
    id: 'pair-synthetic',
    status:
      scenario === 'claim-claimed' || scenario === 'poll-claimed'
        ? 'claimed'
        : 'pending',
    expires_at: new Date(Date.now() + (expired ? -60000 : 60000)).toISOString(),
    consumed_at: scenario.includes('consumed') ? '2026-01-01' : null,
    server_url: 'https://synthetic.invalid',
    connector_id: 'connector-synthetic',
    connector_token: 'synthetic-token',
  }
  const query = async (sql: string) => {
    if (sql.startsWith('SELECT * FROM pairing_codes'))
      return ['claim-missing', 'poll-missing'].includes(scenario) ||
        (!poll && expired)
        ? []
        : [pair]
    return [{ id: pair.id }]
  }
  const db = {
    query,
    transaction: async (action: (db: object) => Promise<unknown>) =>
      action({ query }),
  }
  const store = {
    db,
    connector: async () => {
      if (scenario === 'claim-foreign')
        throw new ApiError(404, 'connector not found')
      return {
        id: 'connector-synthetic',
        token_hash: hashToken('synthetic-token'),
      }
    },
  }
  // 仅替换存储端口，保留真实路由分支、状态码和错误消息。
  registerDeviceRoutes(
    {
      add: (_method: string, path: string, handler: Handler) =>
        handlers.set(path, handler),
    } as never,
    { store, isOnline: () => false } as never,
  )
  const body: Row = poll
    ? { pairingId: pair.id }
    : { code: '123456', connectorId: 'connector-synthetic' }
  if (!poll && scenario !== 'claim-token-missing')
    body.connectorToken =
      scenario === 'claim-token-wrong' ? 'wrong-token' : 'synthetic-token'
  try {
    const value = await handlers.get(
      poll ? '/pairing/poll' : '/pairing/claim',
    )!({ body, account: { userId: 'synthetic-owner' } })
    if (value && typeof value === 'object' && 'serverTime' in value)
      (value as Row).serverTime = '<time>'
    return { status: 200, value }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { status: error.status, detail: error.message }
  }
}
const inputs: string[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
