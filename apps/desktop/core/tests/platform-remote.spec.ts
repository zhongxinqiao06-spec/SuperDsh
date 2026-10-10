import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { PlatformSpaces } from '../src/main/platform-spaces.ts'
import { PlatformAccount } from '../src/main/platform-account.ts'
import { PlatformRemote } from '../src/main/platform-remote.ts'
import type { PlatformEvent } from '../src/contracts/platform.ts'
it('uses real authenticated API v2 HTTP and ticketed WebSocket for device chat, input and uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superdsh-remote-test-'))
  const received: { path: string; authorization: string; body: string }[] = []
  let upgraded: Duplex | undefined
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const path = new URL(request.url!, 'http://127.0.0.1').pathname
    received.push({
      path,
      authorization: request.headers.authorization ?? '',
      body,
    })
    response.setHeader('Content-Type', 'application/json')
    const result = path.endsWith('/oauth/token')
      ? {
          access_token: 'access-test',
          refresh_token: 'refresh-test',
          expires_in: 900,
        }
      : path.endsWith('/auth/me')
        ? {
            userId: 'alice',
            username: 'alice',
            roles: ['member'],
            permissions: [],
            authzVersion: 1,
          }
        : path.endsWith('/ws-ticket')
          ? { ticket: 'single-use-ticket' }
          : path.endsWith('/connectors')
            ? {
                connectors: [
                  { id: 'device', userId: 'alice', status: 'online' },
                ],
              }
            : path.endsWith('/snapshot')
              ? {
                  session: { id: 'session' },
                  timeline: {
                    items: [{ id: 'one', content: { text: 'hello' } }],
                    hasMore: false,
                  },
                  effectiveCapabilities: { capabilities: [] },
                }
              : path.endsWith('/attachments')
                ? { attachments: [{ attachmentId: 'a' }] }
                : path.endsWith('/create-and-start')
                  ? {
                      session: { id: 'rejected' },
                      connectorResult: { ok: false, message: 'Choose a model' },
                    }
                  : { ok: true }
    response.end(JSON.stringify(result))
  })
  server.on('upgrade', (request, socket) => {
    expect(request.url).toBe(
      '/api/v2/sessions/session/ws?ticket=single-use-ticket',
    )
    upgraded = socket
    const accept = createHash('sha1')
      .update(
        String(request.headers['sec-websocket-key']) +
          '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
      )
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const payload = Buffer.from(
      JSON.stringify({
        type: 'timeline.item.updated',
        payload: { text: 'streaming' },
      }),
    )
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let browser = ''
  const account = new PlatformAccount(
    new PlatformSpaces(join(root, 'default'), join(root, 'local')),
    {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    async (url) => {
      browser = url
    },
    async () => {},
  )
  const events: PlatformEvent[] = [],
    remote = new PlatformRemote(account, (event) => events.push(event))
  try {
    await account.login(origin)
    const authorization = new URL(new URL(browser).hash.slice(1), origin),
      callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('code', 'test-code')
    await fetch(callback)
    await vi.waitFor(() => expect(account.state().user?.userId).toBe('alice'))
    expect(await remote.request({ operation: 'devices' })).toMatchObject({
      connectors: [{ userId: 'alice' }],
    })
    await expect(
      remote.request({ operation: 'create-session', body: {} }),
    ).rejects.toThrow('Choose a model')
    expect(
      await remote.request({ operation: 'snapshot', sessionId: 'session' }),
    ).toMatchObject({ timeline: { items: [{ id: 'one' }] } })
    await remote.watch('session')
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            typeof event.event === 'object' &&
            event.event !== null &&
            'type' in event.event &&
            event.event.type === 'timeline.item.updated',
        ),
      ).toBe(true),
    )
    await remote.request({
      operation: 'send',
      sessionId: 'session',
      body: { content: 'hello', clientMessageId: 'unique' },
    })
    await remote.request({
      operation: 'terminal-write',
      connectorId: 'device',
      terminalId: 'term',
      body: { data: '你好\r' },
    })
    await remote.upload('session', [
      {
        name: 'test.txt',
        type: 'text/plain',
        data: new TextEncoder().encode('attachment'),
      },
    ])
    expect(
      received
        .filter((row) => !row.path.endsWith('/oauth/token'))
        .every((row) => row.authorization === 'Bearer access-test'),
    ).toBe(true)
    expect(
      JSON.parse(received.find((row) => row.path.endsWith('/write'))!.body),
    ).toEqual({ dataBase64: Buffer.from('你好\r').toString('base64') })
    expect(
      received.find((row) => row.path.endsWith('/attachments'))!.body,
    ).toContain('attachment')
  } finally {
    await remote.close()
    await account.close()
    upgraded?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects stale identity targets before any request, upload or subscription can reach a replacement account', async () => {
  const oldIdentity = { key: 'a'.repeat(64), generation: 1 }
  const identity = { key: 'b'.repeat(64), generation: 2 }
  const account = {
    identity: () => identity,
    json: vi.fn(async () => null),
    fetch: vi.fn(async () => Response.json({ attachments: [] })),
  }
  const remote = new PlatformRemote(
    account as unknown as PlatformAccount,
    vi.fn(),
  )
  await expect(
    remote.request({
      identity: oldIdentity,
      operation: 'write-file',
      connectorId: 'same-id-on-two-platforms',
      body: { path: 'x', content: 'wrong-account-write' },
    }),
  ).rejects.toThrow('平台账号已切换')
  await expect(
    remote.upload('same-session-id', [], oldIdentity),
  ).rejects.toThrow('平台账号已切换')
  await expect(
    remote.watch('same-session-id', 'old-owner', oldIdentity),
  ).rejects.toThrow('平台账号已切换')
  expect(account.json).not.toHaveBeenCalled()
  expect(account.fetch).not.toHaveBeenCalled()
})

it('discards a late catalog result instead of relabeling it with the new identity scope', async () => {
  let identity = { key: 'a'.repeat(64), generation: 1 }
  let settle!: (result: { providers: never[] }) => void
  const account = {
    identity: () => identity,
    json: vi.fn(
      () =>
        new Promise<{ providers: never[] }>((resolve) => {
          settle = resolve
        }),
    ),
  }
  const remote = new PlatformRemote(
    account as unknown as PlatformAccount,
    vi.fn(),
  )
  const result = remote.request({
    operation: 'model-catalog',
    identity: { ...identity },
  })
  identity = { key: 'b'.repeat(64), generation: 2 }
  settle({ providers: [] })
  await expect(result).rejects.toThrow('平台账号已切换')
})

it('does not let delayed cleanup of an old renderer owner close the replacement subscription', async () => {
  const identity = { key: 'a'.repeat(64), generation: 1 }
  const sockets: { closed: boolean }[] = []
  class Socket {
    closed = false
    constructor() {
      sockets.push(this)
    }
    close() {
      this.closed = true
    }
  }
  vi.stubGlobal('WebSocket', Socket)
  const account = {
    identity: () => identity,
    origin: 'https://fixture.invalid',
    json: vi.fn(async () => ({ ticket: 'test-only' })),
  }
  const remote = new PlatformRemote(
    account as unknown as PlatformAccount,
    vi.fn(),
  )
  try {
    await remote.watch('old-session', 'old-owner', identity)
    await remote.watch('new-session', 'new-owner', identity)
    expect(sockets[0]!.closed).toBe(true)
    await remote.stopWatch('old-owner')
    expect(sockets[1]!.closed).toBe(false)
    await remote.stopWatch('new-owner')
    expect(sockets[1]!.closed).toBe(true)
  } finally {
    await remote.close()
    vi.unstubAllGlobals()
  }
})
