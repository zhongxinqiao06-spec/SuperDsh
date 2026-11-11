/** 执行旧终端真实handler；仅替换设备RPC和SQL传输，不创建实际终端或读取用户配置。 */
import { readFileSync } from 'node:fs'

type Row = Record<string, unknown>
type Handler = (context: Row) => Promise<unknown>
interface Input {
  scope: string
  body: Row
  query?: string
  endpoint?: string
  method?: string
  result?: Row
  captureParameters?: boolean
}
interface LegacyService {
  hub: object
  registerTerminals(router: object): void
  terminalCall: (
    connector: string,
    terminal: string,
    method: string,
    params: Row,
  ) => Promise<Row>
}
const { FileService }: { FileService: { prototype: object } } = await import(
  new URL('../../../admin/server/files/service.ts', import.meta.url).href
)

async function probe(input: Input) {
  let observed: Row = {}
  const handlers = new Map<string, Handler>()
  const service = Object.create(FileService.prototype) as LegacyService
  service.hub = {
    store: {
      db: { query: async () => [{ root: '/workspace', cwd: '/workspace' }] },
      connector: async () => ({ id: 'synthetic-connector' }),
      session: async () => ({
        id: 'synthetic-session',
        connector_id: 'synthetic-connector',
        cwd: '/workspace/session',
      }),
    },
    connectorAllowed: async () => {},
    call: async (_connector: string, _method: string, params: Row) => {
      observed = { ...params, terminalId: '<generated-terminal>' }
      return input.result ?? { terminal: { terminalId: params.terminalId } }
    },
  }
  service.terminalCall = async (_connector, _terminal, _method, params) => {
    observed = params
    return input.result || {}
  }
  service.registerTerminals({
    add: (method: string, path: string, handler: Handler) =>
      handlers.set(`${method} ${path}`, handler),
  })
  const handler = handlers.get(
    `${input.method || 'POST'} ${input.endpoint || `/${input.scope}/{target_id}/terminals`}`,
  )
  if (!handler) throw new Error('missing real terminal handler')
  const response = await handler({
    body: input.body,
    url: new URL('http://synthetic.invalid/' + (input.query || '')),
    account: { userId: 'synthetic-owner' },
    params: {
      target_id:
        input.scope === 'sessions'
          ? 'synthetic-session'
          : 'synthetic-connector',
      terminal_id: 'synthetic-terminal',
    },
    signal: new AbortController().signal,
  })
  return input.captureParameters
    ? { response, params: observed }
    : input.endpoint
      ? response
      : observed
}
const input: Input[] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(input.map(probe))))
