/** Allowlisted API v2 operations. Account credentials and socket tickets remain in main. */
import { randomUUID } from 'node:crypto'
import type {
  PlatformEvent,
  PlatformJson,
  PlatformRequest,
  PlatformIdentitySnapshot,
} from '../contracts/platform.ts'
import type { PlatformAccount } from './platform-account.ts'
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 512)
    throw new Error('缺少设备或会话标识')
  return encodeURIComponent(value)
}
export function remoteRoute(request: PlatformRequest): {
  path: string
  method: string
  body?: PlatformJson
} {
  let path: string
  let method = 'GET'
  switch (request.operation) {
    case 'server-agent':
    case 'prepare-server-agent':
      path = '/server-agent'
      method = request.operation === 'prepare-server-agent' ? 'POST' : 'GET'
      break
    case 'personal-providers':
    case 'create-personal-provider':
      path = '/models/personal/providers'
      method = request.operation === 'create-personal-provider' ? 'POST' : 'GET'
      break
    case 'update-personal-provider':
    case 'delete-personal-provider':
    case 'verify-personal-provider':
      path = `/models/personal/providers/${id(request.providerId)}${request.operation === 'verify-personal-provider' ? '/verify' : ''}`
      method =
        request.operation === 'update-personal-provider'
          ? 'PATCH'
          : request.operation === 'delete-personal-provider'
            ? 'DELETE'
            : 'POST'
      break
    case 'personal-default':
    case 'set-personal-default':
      path = '/models/personal/default'
      method = request.operation === 'set-personal-default' ? 'PUT' : 'GET'
      break
    case 'devices':
      path = '/connectors'
      break
    case 'projects':
      path = '/projects'
      break
    case 'create-project':
      path = '/projects'
      method = 'POST'
      break
    case 'sessions':
      path = '/sessions'
      break
    case 'runtimes':
      path = `/connectors/${id(request.connectorId)}/runtimes`
      break
    case 'runtime-models':
    case 'runtime-permissions':
      path = `/connectors/${id(request.connectorId)}/runtimes/${id(request.runtimeId)}/catalogs/${request.operation === 'runtime-models' ? 'model' : 'permission'}`
      break
    case 'model-catalog':
      path = '/models/catalog'
      break
    case 'create-session':
      path = '/sessions/create-and-start'
      method = 'POST'
      break
    case 'snapshot':
    case 'timeline':
    case 'events':
      path = `/sessions/${id(request.sessionId)}/${request.operation}`
      break
    case 'send':
      path = `/sessions/${id(request.sessionId)}/runtime/messages`
      method = 'POST'
      break
    case 'interrupt':
      path = `/sessions/${id(request.sessionId)}/runtime/interrupt`
      method = 'POST'
      break
    case 'state':
    case 'capabilities':
      path = `/sessions/${id(request.sessionId)}/runtime/${request.operation}`
      break
    case 'models':
      path = `/sessions/${id(request.sessionId)}/runtime/catalogs/model`
      break
    case 'permissions':
      path = `/sessions/${id(request.sessionId)}/runtime/catalogs/permission`
      break
    case 'selections':
      path = `/sessions/${id(request.sessionId)}/runtime/selections`
      method = 'PATCH'
      break
    case 'respond':
      path = `/sessions/${id(request.sessionId)}/runtime/notices/${id(request.noticeId)}/respond`
      method = 'POST'
      break
    case 'files':
      path = `/connectors/${id(request.connectorId)}/fs/list`
      method = 'POST'
      break
    case 'read-file':
      path = `/connectors/${id(request.connectorId)}/fs/readText`
      method = 'POST'
      break
    case 'write-file':
      path = `/connectors/${id(request.connectorId)}/fs/write`
      method = 'POST'
      break
    case 'terminals':
      path = `/connectors/${id(request.connectorId)}/terminals-v2`
      break
    case 'create-terminal':
      path = `/connectors/${id(request.connectorId)}/terminals-v2`
      method = 'POST'
      break
    case 'terminal-snapshot':
    case 'terminal-write':
    case 'terminal-resize':
    case 'terminal-close': {
      const suffix = request.operation.slice('terminal-'.length)
      path = `/connectors/${id(request.connectorId)}/terminals-v2/${id(request.terminalId)}${suffix === 'close' ? '' : '/' + suffix}`
      method =
        suffix === 'close' ? 'DELETE' : suffix === 'snapshot' ? 'GET' : 'POST'
      break
    }
    default:
      throw new Error('不支持的平台操作')
  }
  if (request.query) {
    if (
      Object.keys(request.query).length > 12 ||
      Object.values(request.query).some(
        (value) => typeof value !== 'string' || value.length > 1024,
      )
    )
      throw new Error('Invalid platform query')
    path += `?${new URLSearchParams(request.query)}`
  }
  if (JSON.stringify(request.body ?? null).length > 8 * 1024 * 1024)
    throw new Error('请求内容过大')
  let body = request.body ?? {}
  if (request.operation === 'terminal-write') {
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      typeof body.data !== 'string'
    )
      throw new Error('Invalid terminal input')
    body = { dataBase64: Buffer.from(body.data, 'utf8').toString('base64') }
  }
  return {
    path,
    method,
    ...(method === 'GET' ? {} : { body }),
  }
}
export class PlatformRemote {
  private socket: WebSocket | undefined
  private generation = 0
  private ownerId: string | undefined
  private reconnect: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly account: PlatformAccount,
    private readonly emit: (event: PlatformEvent) => void,
  ) {}
  private identity(
    expected?: PlatformIdentitySnapshot,
  ): PlatformIdentitySnapshot {
    const current = this.account.identity()
    if (!current) throw new Error('请登录管理平台。')
    if (
      expected !== undefined &&
      (!expected ||
        typeof expected.key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expected.key) ||
        !Number.isSafeInteger(expected.generation) ||
        expected.key !== current.key ||
        expected.generation !== current.generation)
    )
      throw new Error('平台账号已切换，此目标操作已取消。')
    return { ...current }
  }
  private current(expected: PlatformIdentitySnapshot): boolean {
    const current = this.account.identity()
    return (
      current?.key === expected.key &&
      current.generation === expected.generation
    )
  }
  async request(request: PlatformRequest): Promise<PlatformJson> {
    const identity = this.identity(request.identity)
    const route = remoteRoute(request)
    const response = await this.account.json(
      route.path,
      route.method,
      route.body,
    )
    this.identity(identity)
    const body =
      response && typeof response === 'object' && !Array.isArray(response)
        ? response
        : {}
    const nested = body.connectorResult
    const failure =
      body.ok === false
        ? body
        : nested &&
            typeof nested === 'object' &&
            !Array.isArray(nested) &&
            nested.ok === false
          ? nested
          : undefined
    if (failure)
      throw new Error(
        typeof failure.message === 'string'
          ? failure.message
          : '目标设备拒绝了此操作',
      )
    if (request.operation === 'model-catalog')
      return { ...body, scope: identity.key }
    return response
  }
  async watch(
    sessionId: string | null,
    ownerId?: string,
    expected?: PlatformIdentitySnapshot,
  ): Promise<void> {
    const identity = sessionId === null ? undefined : this.identity(expected)
    if (ownerId !== undefined && (!ownerId || ownerId.length > 128))
      throw new Error('Invalid conversation subscription owner')
    this.ownerId = ownerId
    const generation = ++this.generation
    clearTimeout(this.reconnect)
    this.socket?.close()
    this.socket = undefined
    if (sessionId === null) return
    id(sessionId)
    const open = async () => {
      if (
        generation !== this.generation ||
        !identity ||
        !this.current(identity)
      )
        return
      try {
        const value = (await this.account.json('/ws-ticket', 'POST', {
          clientId: `superdsh-${randomUUID()}`,
          scope: { sessionId },
        })) as { ticket: string }
        if (generation !== this.generation || !this.current(identity)) return
        if (typeof value.ticket !== 'string')
          throw new Error('平台未返回会话连接票据')
        const url = new URL(
          `/api/v2/sessions/${id(sessionId)}/ws`,
          this.account.origin,
        )
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('ticket', value.ticket)
        const socket = new WebSocket(url)
        this.socket = socket
        socket.onmessage = (event) => {
          if (
            generation !== this.generation ||
            !this.current(identity) ||
            typeof event.data !== 'string' ||
            event.data.length > 8 * 1024 * 1024
          )
            return
          try {
            this.emit({
              sessionId,
              identity,
              event: JSON.parse(event.data) as PlatformJson,
            })
          } catch {
            /* Malformed frames never update product state. */
          }
        }
        socket.onopen = () => {
          if (generation === this.generation && this.current(identity))
            this.emit({
              sessionId,
              identity,
              event: { type: 'superdsh.reconnected' },
            })
        }
        socket.onclose = () => {
          if (generation === this.generation && this.current(identity))
            this.reconnect = setTimeout(() => {
              void open()
            }, 3000)
        }
        socket.onerror = () => socket.close()
      } catch {
        if (generation === this.generation && this.current(identity))
          this.reconnect = setTimeout(() => {
            void open()
          }, 5000)
      }
    }
    await open()
  }
  async stopWatch(ownerId: string): Promise<void> {
    if (this.ownerId === ownerId) await this.watch(null)
  }
  async upload(
    sessionId: string,
    files: { name: string; type: string; data: Uint8Array }[],
    expected?: PlatformIdentitySnapshot,
  ): Promise<PlatformJson> {
    const identity = this.identity(expected)
    id(sessionId)
    if (
      !Array.isArray(files) ||
      files.length > 10 ||
      files.reduce((size, file) => size + file.data.byteLength, 0) >
        32 * 1024 * 1024
    )
      throw new Error('附件总大小不能超过 32 MiB，单次最多 10 个')
    const form = new FormData()
    for (const file of files)
      form.append(
        'files',
        new Blob([new Uint8Array(file.data)], { type: file.type }),
        file.name.slice(0, 255),
      )
    const response = await this.account.fetch(
      `/sessions/${id(sessionId)}/attachments`,
      { method: 'POST', body: form },
    )
    const result = (await response.json()) as PlatformJson
    this.identity(identity)
    return result
  }
  close(): Promise<void> {
    return this.watch(null)
  }
}
