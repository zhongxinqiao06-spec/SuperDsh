import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import { parseProtocolEvent } from '../../src/components/session/protocol-event.ts'
import { ApiError, ApiRouter } from '../http/api-router.ts'
import { ConnectorHub } from '../devices/connector-hub.ts'
import { registerDeviceRoutes } from '../devices/routes.ts'
import { registerConversationRoutes } from '../conversations/routes.ts'
import { FileService, resolveRemotePath } from '../files/service.ts'
import { createFileStorage } from '../files/storage.ts'
import { NativeDevice, resolveNativePath } from '../devices/native-device.ts'
import {
  decodeCursor,
  encodeCursor,
  hashToken,
} from '../conversations/store.ts'
import { withTestDatabase } from './support/database.mjs'
import { workspaceIdentity } from '../conversations/workspace.ts'

test('POSIX workspace identities preserve a literal trailing backslash', () => {
  const literal = '/srv/用户/Agent workspace\\'
  assert.equal(workspaceIdentity(literal, 'linux').display, literal)
  assert.equal(workspaceIdentity(`${literal}/`, 'linux').key, literal)
  assert.notEqual(
    workspaceIdentity(literal, 'linux').key,
    workspaceIdentity('/srv/用户/Agent workspace/', 'linux').key,
  )
  assert.equal(
    workspaceIdentity('D:\\项目\\Agent workspace\\', 'win32').key,
    'd:/项目/agent workspace',
  )
})

test('session streams and reconnect recovery are accepted by the actual browser parser and restore final runtime state', async (t) => {
  const f = await fixture(t)
  const ticket = await f.api('/ws-ticket', {
    method: 'POST',
    body: {
      clientId: 'browser-protocol-test',
      scope: { sessionId: f.sessionId },
    },
  })
  const received = []
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/sessions/${f.sessionId}/ws?ticket=${ticket.body.ticket}`,
  )
  ws.on('message', (data) => received.push(parseProtocolEvent(data.toString())))
  t.after(() => ws.close())
  await once(ws, 'open')
  await f.hub.notify(f.connectorId, 'session.state.updated', {
    runtime: 'dsh',
    runtimeId: 'dsh',
    sessionId: f.sessionId,
    status: 'running',
  })
  await f.hub.notify(f.connectorId, 'timeline.itemUpsert', {
    runtime: 'dsh',
    runtimeId: 'dsh',
    sessionId: f.sessionId,
    item: {
      id: 'browser-completed',
      sessionId: f.sessionId,
      type: 'message',
      role: 'assistant',
      status: 'done',
      orderSeq: 1,
      revision: 1,
      content: { text: 'BROWSER_STREAM_COMPLETE' },
    },
  })
  await f.hub.notify(f.connectorId, 'session.turnEnded', {
    runtime: 'dsh',
    runtimeId: 'dsh',
    sessionId: f.sessionId,
  })
  const end = Date.now() + 3000
  while (
    !received.some(
      (event) =>
        event?.type === 'runtime.state.updated' &&
        event.payload.state?.status === 'idle',
    )
  ) {
    if (Date.now() > end)
      assert.fail(
        `Browser discarded stream envelopes: ${JSON.stringify(received)}`,
      )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(
    received.every(Boolean),
    'the browser accepts every emitted session event',
  )
  assert.ok(received.some((event) => event.type === 'session.subscribed'))
  assert.ok(
    received.some(
      (event) =>
        event.payload.item?.content?.text === 'BROWSER_STREAM_COMPLETE',
    ),
  )
  const [row] = await f.db.query('SELECT * FROM sessions WHERE id=$1', [
    f.sessionId,
  ])
  f.hub.liveState.set(f.sessionId, {
    sessionId: f.sessionId,
    status: 'running',
    updatedSeq: 0,
    error: null,
  })
  for (const after of [0, Number(row.seq)]) {
    const response = await f.api(
      `/sessions/${f.sessionId}/events?after=seq:${after}`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.body.snapshotRequired, false)
    const events = response.body.events.map((event) =>
      parseProtocolEvent(JSON.stringify(event)),
    )
    assert.ok(events.every(Boolean))
    const state = events.find((event) => event.type === 'runtime.state.updated')
    assert.equal(
      state.payload.state.status,
      'idle',
      'stale live state cannot undo committed completion',
    )
    assert.equal(state.payload.state.updatedSeq, Number(row.updated_seq))
    assert.equal(state.sequence, Number(row.updated_seq))
    assert.ok(
      events.every(
        (event, index) =>
          index === 0 || events[index - 1].sequence <= event.sequence,
      ),
    )
  }
  const closed = once(ws, 'close')
  ws.close()
  await closed
})

async function fixture(t) {
  let cleanupDatabase
  const db = await withTestDatabase({
    after: (callback) => {
      cleanupDatabase = callback
    },
  })
  const permissions = [
    'devices.read',
    'devices.manage',
    'sessions.read',
    'sessions.run',
    'projects.read',
    'projects.manage',
    'files.read',
    'files.write',
    'terminal.use',
    'models.use',
  ]
  const accounts = new Map(
    ['alice', 'bob'].map((userId) => [
      userId,
      {
        userId,
        username: userId,
        email: null,
        emailVerified: false,
        displayName: userId,
        role: 'member',
        roles: ['member'],
        permissions: [...permissions],
        authzVersion: 1,
        resetRequired: false,
        disabled: false,
        deletedAt: null,
      },
    ]),
  )
  const revoked = new Set()
  const authenticateToken = async (token) => {
    const user = accounts.get(token)
    if (!user || user.disabled || revoked.has(token))
      throw new ApiError(401, 'invalid token')
    return user
  }
  const authorize = async (request, permission) => {
    const user = await authenticateToken(
      (request.headers.authorization || '').replace('Bearer ', ''),
    )
    if (permission && !user.permissions.includes(permission))
      throw new ApiError(403, 'permission denied')
    return user
  }
  for (const userId of accounts.keys())
    await db.query(
      'INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES($1,$1,$2,$3,$3)',
      [userId, 'synthetic', new Date().toISOString()],
    )
  const hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-secret',
    authenticateToken,
    getUser: async (id) => accounts.get(id),
  })
  const root = await mkdtemp(path.join(tmpdir(), 'superdsh-node-files-'))
  const files = new FileService(hub, root)
  const router = new ApiRouter(authorize)
  registerDeviceRoutes(router, hub)
  registerConversationRoutes(router, hub, files)
  files.register(router)
  const server = createServer((request, response) => {
    void router.handle(request, response, {
      signal: new AbortController().signal,
    })
  })
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (
        !(await hub.handleUpgrade(request, socket, head)) &&
        !(await files.handleUpgrade(request, socket, head))
      )
        socket.destroy()
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    files.close()
    await hub.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
    await cleanupDatabase()
  })
  const api = async (
    route,
    { token = 'alice', method = 'GET', body, headers, ...options } = {},
  ) => {
    const response = await fetch(`${origin}/api/v2${route}`, {
      ...options,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  const created = await api('/connectors', {
    method: 'POST',
    body: { name: 'test desktop', connectorKind: 'desktop' },
  })
  assert.equal(created.status, 200)
  const connectorId = created.body.connector.id
  const calls = []
  const local = {
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'runtime.discover')
        return {
          runtimeTypes: [
            {
              runtimeType: 'dsh',
              displayName: 'Harness',
              implementationType: 'dsh',
              available: true,
              instancePolicy: 'single',
              maxInstances: 1,
              capabilities: {},
              metadata: {},
              configSchema: {
                schema: { type: 'object' },
                uiSchema: {},
                defaults: {},
              },
            },
          ],
        }
      if (method === 'session.create')
        return {
          sessionId: params.sessionId,
          externalSessionId: 'native-1',
          runtimeId: 'dsh',
          status: 'idle',
        }
      if (method === 'session.capabilities')
        return {
          capabilitySet: {
            revision: 1,
            capabilities: [
              'session.send_message',
              'session.interrupt',
              'session.steer',
              'session.commands',
              'session.interaction.approval',
              'catalog.model',
              'catalog.permission',
              'runtime.attachment',
            ].map((capabilityId) => ({
              capabilityId,
              scope: 'session',
              sessionId: params.sessionId,
              runtime: 'dsh',
              runtimeId: 'dsh',
              supported: true,
              available: true,
              allowed: true,
            })),
          },
        }
      if (
        method === 'runtime.modelCatalog' ||
        method === 'runtime.permissionCatalog'
      )
        return { catalog: { revision: 1, options: [] } }
      if (method === 'session.notices') return { notices: [] }
      return { ok: true }
    },
  }
  await hub.registerLocal(connectorId, local)
  await hub.discover(connectorId)
  await db.query(
    "UPDATE device_runtimes SET config_json='{}',active=1,status='running' WHERE connector_id=$1",
    [connectorId],
  )
  const project = await api('/projects', {
    method: 'POST',
    body: { name: 'workspace', connectorId, workspacePath: root },
  })
  assert.equal(project.status, 200)
  const createdSession = await api('/sessions/create-and-start', {
    method: 'POST',
    body: {
      connectorId,
      projectId: project.body.project.id,
      runtime: 'dsh',
      content: 'test',
      clientMessageId: 'client-message-1',
    },
  })
  assert.equal(createdSession.status, 200)
  return {
    db,
    hub,
    files,
    router,
    accounts,
    revoked,
    origin,
    api,
    connectorId,
    connectorToken: created.body.connectorToken,
    sessionId: createdSession.body.session.id,
    projectId: project.body.project.id,
    root,
    calls,
    local,
  }
}

test('API ownership, schema-compatible metadata, model selections, and message RPC binding', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await f.api(`/sessions/${f.sessionId}/meta`, { token: 'bob' })).status,
    404,
  )
  assert.equal(
    (await f.api(`/connectors/${f.connectorId}`, { token: 'bob' })).status,
    404,
  )
  assert.equal(
    (await f.api('/projects')).body.projects[0].activeSessionCount,
    1,
  )
  const sent = await f.api(`/sessions/${f.sessionId}/runtime/messages`, {
    method: 'POST',
    body: {
      content: 'hello',
      clientMessageId: 'id-2',
      sessionId: 'another-user-session',
    },
  })
  assert.equal(sent.status, 200)
  assert.equal(f.calls.at(-1).method, 'session.send_message')
  assert.equal(f.calls.at(-1).params.sessionId, f.sessionId)
  const selection = await f.api(`/sessions/${f.sessionId}/runtime/selections`, {
    method: 'PATCH',
    body: { selections: { model: 'deepseek-chat' } },
  })
  assert.equal(selection.status, 200)
  assert.equal(
    (
      await f.db.query('SELECT model_selection_id FROM sessions WHERE id=$1', [
        f.sessionId,
      ])
    )[0].model_selection_id,
    'deepseek-chat',
  )
  f.accounts.get('alice').permissions = ['sessions.read']
  assert.equal(
    (
      await f.api(`/sessions/${f.sessionId}/runtime/messages`, {
        method: 'POST',
        body: { content: 'denied' },
      })
    ).status,
    403,
  )
})

test('timeline dedup and durable cursors survive reconnect; forged connector binding rejected', async (t) => {
  const f = await fixture(t)
  const item = {
    id: 'item-1',
    sessionId: f.sessionId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    orderSeq: 1,
    revision: 1,
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
    content: { text: 'hello' },
  }
  const notification = {
    method: 'timeline.itemUpsert',
    params: { sessionId: f.sessionId, runtime: 'dsh', runtimeId: 'dsh', item },
  }
  const first = await f.hub.ingest(f.connectorId, {
    notifications: [notification],
  })
  assert.equal(first.accepted, 1)
  const initial = await f.api(`/sessions/${f.sessionId}/timeline`)
  await f.hub.ingest(f.connectorId, { notifications: [notification] })
  const repeat = await f.api(`/sessions/${f.sessionId}/timeline`)
  assert.equal(repeat.body.nextSeq, initial.body.nextSeq)
  assert.equal(repeat.body.items.length, 1)
  await f.hub.ingest(f.connectorId, {
    notifications: [
      {
        ...notification,
        params: {
          ...notification.params,
          item: { ...item, revision: 2, content: { text: 'updated' } },
        },
      },
    ],
  })
  const changes = await f.api(
    `/sessions/${f.sessionId}/timeline?mode=changes&afterSeq=${initial.body.nextSeq}`,
  )
  assert.equal(changes.body.items[0].content.text, 'updated')
  const events = await f.api(
    `/sessions/${f.sessionId}/events?after=seq:${initial.body.nextSeq}`,
  )
  const updated = events.body.events.find(
    (event) => event.type === 'timeline.item_updated',
  )
  assert.equal(updated.cursor, `seq:${changes.body.nextSeq}`)
  assert.equal(events.body.snapshotRequired, false)
  const invalidFuture = await f.api(
    `/sessions/${f.sessionId}/events?after=seq:9000`,
  )
  assert.equal(invalidFuture.body.snapshotRequired, true)
  const other = await f.hub.store.createConnector('bob', { name: 'other' })
  const forged = await f.hub.ingest(other.connector.id, {
    notifications: [notification],
  })
  assert.equal(forged.accepted, 0)
  assert.equal(forged.rejected.length, 1)
})

test('session WebSocket tickets are one-use and ordered deltas are not dropped', async (t) => {
  const f = await fixture(t)
  const issued = await f.api('/ws-ticket', {
    method: 'POST',
    body: { clientId: 'test-browser', scope: { sessionId: f.sessionId } },
  })
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/sessions/${f.sessionId}/ws?ticket=${issued.body.ticket}`,
  )
  const messages = []
  ws.on('message', (data) => messages.push(JSON.parse(data)))
  await once(ws, 'open')
  for (let i = 0; i < 5; i++)
    f.hub.emit(f.sessionId, i + 10, 'runtime.state.updated', {
      state: { sessionId: f.sessionId, status: 'running', updatedSeq: i + 10 },
    })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(
    messages.filter((event) => event.type === 'runtime.state.updated').length,
    5,
  )
  await assert.rejects(
    f.hub.consumeTicket(issued.body.ticket, f.sessionId),
    /invalid WebSocket ticket/,
  )
  f.revoked.add('alice')
  await f.hub.revalidateUser('alice')
  if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close')
  assert.equal(
    f.hub.isOnline(f.connectorId),
    true,
    'client logout must not stop admitted Agent execution',
  )
})

test('connector token rotation and account disable revoke old credentials and pending RPC', async (t) => {
  const f = await fixture(t)
  const auth = await f.hub.exchangeConnector(
    `Connector ${f.connectorId}:${f.connectorToken}`,
  )
  assert.equal(
    (await f.hub.authenticateConnector(auth.accessToken)).id,
    f.connectorId,
  )
  await f.api(`/connectors/${f.connectorId}/revoke`, { method: 'POST' })
  await assert.rejects(
    f.hub.authenticateConnector(auth.accessToken),
    /invalid connector access token/,
  )
  assert.equal(f.hub.isOnline(f.connectorId), false)
  await f.hub.registerLocal(f.connectorId, {
    call: () => new Promise(() => {}),
  })
  const pending = f.hub.call(f.connectorId, 'session.state', {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const rejected = assert.rejects(pending, /disconnected/)
  f.accounts.get('alice').disabled = true
  await f.hub.revalidateUser('alice')
  await rejected
  assert.equal(f.hub.isOnline(f.connectorId), false)
})

test('attachments preserve old blobs, owner checks and signed link invalidation', async (t) => {
  const f = await fixture(t)
  const saved = await f.files.save(
    'alice',
    f.sessionId,
    '中文.txt',
    Buffer.from('data'),
    'text/plain',
  )
  assert.equal(
    (
      await f.api(`/sessions/${f.sessionId}/attachments/${saved.fileId}`, {
        token: 'bob',
      })
    ).status,
    404,
  )
  const response = await fetch(
    `${f.origin}/api/v2/sessions/${f.sessionId}/attachments/${saved.fileId}/open`,
    { headers: { authorization: 'Bearer alice' }, redirect: 'manual' },
  )
  assert.equal(response.status, 302)
  const url = new URL(response.headers.get('location'), f.origin)
  assert.equal(await (await fetch(url)).text(), 'data')
  f.revoked.add('alice')
  assert.equal((await fetch(url)).status, 401)
  assert.equal(
    (
      await f.files.downloadAttachment(f.connectorId, f.sessionId, saved.fileId)
    ).content.toString(),
    'data',
  )
})

test('native device confines paths and omits API secrets from real shell environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'superdsh-native-device-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'hello.txt'), 'hello')
  await assert.rejects(resolveNativePath(root, '../outside'), /outside/)
  assert.throws(
    () => resolveRemotePath('C:\\workspace', '..\\secret'),
    /outside/,
  )
  const device = new NativeDevice(root, () => {}, {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot || '',
    ComSpec: process.env.ComSpec || '',
  })
  t.after(() => device.close())
  const read = await device.call('fs.readText', { path: 'hello.txt' })
  assert.equal(read.content, 'hello')
  await assert.rejects(
    device.call('fs.write', {
      path: 'hello.txt',
      content: 'wrong',
      ifMatch: '0'.repeat(64),
    }),
    (error) => error.status === 412,
  )
  await device.call('fs.write', {
    path: 'hello.txt',
    content: 'updated',
    ifMatch: read.sha256,
  })
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'updated')
  const command = `"${process.execPath}" -e "process.stdout.write(String(process.env.AGENT_SERVER_SECRET || 'absent'))"`
  const output = await device.call('shell.exec', {
    command,
    cwd: '.',
    timeoutMs: 5000,
  })
  assert.equal(output.stdout, 'absent')
})

test('uploaded HTML and SVG cannot execute in the platform origin while images keep previews', async (t) => {
  const f = await fixture(t)
  for (const mediaType of [
    'text/html',
    'image/svg+xml',
    'image/png',
    'application/pdf',
  ]) {
    const file = await f.files.save(
      'alice',
      f.sessionId,
      'sample',
      Buffer.from('<script>window.pwned=true</script>'),
      mediaType,
    )
    const response = await fetch(
      `${f.origin}/api/v2/sessions/${f.sessionId}/attachments/${file.fileId}/open`,
      { headers: { authorization: 'Bearer alice' } },
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy'), /^sandbox;/)
    assert.ok(
      !response.headers
        .get('content-security-policy')
        .includes('allow-same-origin'),
    )
    assert.ok(
      !response.headers
        .get('content-security-policy')
        .includes('allow-scripts'),
    )
    assert.match(
      response.headers.get('content-disposition'),
      ['image/png', 'application/pdf'].includes(mediaType)
        ? /^inline/
        : /^attachment/,
    )
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    await response.arrayBuffer()
  }
})

test('session pagination cursor rejects malformed and version-incompatible values', () => {
  const encoded = encodeCursor({
    id: 'ses_1',
    pinned: 1,
    sort_at: '2026',
    updated_seq: 7,
  })
  assert.equal(decodeCursor(encoded).i, 'ses_1')
  assert.throws(() => decodeCursor('garbage'), /invalid session cursor/)
  assert.throws(
    () => decodeCursor(Buffer.from('{"v":2}').toString('base64url')),
    /invalid session cursor/,
  )
})

test('desktop Connector WebSocket authenticates and carries RPC plus ingress without Python', async (t) => {
  const f = await fixture(t)
  await f.hub.disconnect(f.connectorId)
  const auth = await f.hub.exchangeConnector(
    `Connector ${f.connectorId}:${f.connectorToken}`,
  )
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/connector/ws`,
    { headers: { authorization: `Bearer ${auth.accessToken}` } },
  )
  const seen = []
  ws.on('message', (raw) => {
    const request = JSON.parse(raw)
    if (!request.id) return
    seen.push(request.method)
    const result =
      request.method === 'runtime.discover'
        ? { runtimeTypes: [] }
        : request.method === 'session.capabilities'
          ? {
              capabilitySet: {
                revision: 1,
                capabilities: [
                  {
                    capabilityId: 'session.send_message',
                    scope: 'session',
                    sessionId: request.params.sessionId,
                    runtime: 'dsh',
                    runtimeId: 'dsh',
                    supported: true,
                    available: true,
                    allowed: true,
                  },
                ],
              },
            }
          : { accepted: true, sessionId: request.params.sessionId }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  })
  await once(ws, 'open')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const reply = await f.api(`/sessions/${f.sessionId}/runtime/messages`, {
    method: 'POST',
    body: { content: 'from API' },
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.result.sessionId, f.sessionId)
  assert.ok(seen.includes('session.send_message'))
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session.meta.upsert',
      params: {
        sessionId: f.sessionId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        title: 'desktop synchronized',
      },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(
    (await f.api(`/sessions/${f.sessionId}/meta`)).body.session.title,
    'desktop synchronized',
  )
  const closed = once(ws, 'close')
  await f.hub.disconnect(f.connectorId)
  await closed
})

test('file preview exchange is single-use, reads through native adapter and refuses another root', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'preview.txt'), 'preview content')
  await f.hub.disconnect(f.connectorId)
  const device = new NativeDevice(f.root, () => {}, {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot || '',
  })
  await f.hub.registerLocal(f.connectorId, device)
  const issued = await f.api(
    `/connectors/${f.connectorId}/fs/preview-token?root=${encodeURIComponent(f.root)}`,
    { method: 'POST', body: { path: 'preview.txt' } },
  )
  assert.equal(issued.status, 200)
  const exchanged = await f.api('/connectors/fs/preview-session', {
    method: 'POST',
    body: { previewToken: issued.body.previewToken },
  })
  assert.equal(exchanged.status, 200)
  assert.equal(
    (
      await f.api('/connectors/fs/preview-session', {
        method: 'POST',
        body: { previewToken: issued.body.previewToken },
      })
    ).status,
    401,
  )
  const read = await f.api('/connectors/fs/preview/readText', {
    method: 'POST',
    body: { previewAccessToken: exchanged.body.previewAccessToken },
  })
  assert.equal(read.status, 200)
  assert.equal(read.body.content, 'preview content')
  const transfer = await f.api(
    `/connectors/${f.connectorId}/fs/read?root=${encodeURIComponent(f.root)}`,
    { method: 'POST', body: { path: 'preview.txt' } },
  )
  assert.equal(transfer.status, 200)
  assert.equal(
    await (
      await fetch(new URL(transfer.body.result.downloadUrl, f.origin))
    ).text(),
    'preview content',
  )
  assert.equal(
    (
      await f.api(
        `/connectors/${f.connectorId}/fs/readText?root=${encodeURIComponent(f.root)}`,
        { method: 'POST', body: { path: '../secret' } },
      )
    ).status,
    403,
  )
})

test('desktop file download forwards initial bytes before the upload completes', async (t) => {
  const f = await fixture(t)
  await f.hub.disconnect(f.connectorId)
  const auth = await f.hub.exchangeConnector(
    `Connector ${f.connectorId}:${f.connectorToken}`,
  )
  const first = Buffer.alloc(128 * 1024, 65)
  const last = Buffer.alloc(128 * 1024, 66)
  const content = Buffer.concat([first, last])
  let releaseUpload
  const continueUpload = new Promise((resolve) => {
    releaseUpload = resolve
  })
  t.after(() => releaseUpload())
  let upload
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/connector/ws`,
    { headers: { authorization: `Bearer ${auth.accessToken}` } },
  )
  const calls = []
  ws.on('message', (raw) => {
    const rpc = JSON.parse(raw)
    if (!rpc.id) return
    calls.push(rpc.method)
    let result = { accepted: true }
    if (rpc.method === 'runtime.discover') result = { runtimeTypes: [] }
    if (rpc.method === 'fs.prepareDownload')
      result = {
        name: 'large.bin',
        path: '/work/large.bin',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
    if (rpc.method === 'fs.uploadPreparedDownload') {
      const url = new URL(rpc.params.uploadUrl, f.origin)
      url.searchParams.set('token', rpc.params.token)
      upload = fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${auth.accessToken}` },
        duplex: 'half',
        body: (async function* () {
          yield first
          await continueUpload
          yield last
        })(),
      })
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  await once(ws, 'open')
  const prepared = await f.api(
    `/connectors/${f.connectorId}/fs/read?root=/work`,
    { method: 'POST', body: { path: 'large.bin' } },
  )
  assert.equal(prepared.status, 200)
  const response = await fetch(
    new URL(prepared.body.result.downloadUrl, f.origin),
    { signal: AbortSignal.timeout(5000) },
  )
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const initial = await reader.read()
  assert.ok(initial.value.length > 0)
  assert.equal(initial.value[0], 65)
  releaseUpload()
  const chunks = [Buffer.from(initial.value)]
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(Buffer.from(next.value))
  }
  assert.deepEqual(Buffer.concat(chunks), content)
  assert.equal((await upload).status, 200)
  assert.ok(calls.includes('fs.prepareDownload'))
  assert.ok(calls.includes('fs.uploadPreparedDownload'))
})

test('imported desktop histories create normalized project groups and retain ownership', async (t) => {
  const f = await fixture(t)
  const upsert = (sessionId, cwd) =>
    f.hub.notify(f.connectorId, 'session.meta.upsert', {
      sessionId,
      runtime: 'dsh',
      runtimeId: 'dsh',
      cwd,
      title: sessionId,
    })
  await upsert('import-project-a', 'D:\\Projects\\Example\\')
  await upsert('import-project-b', 'd:/projects/example')
  const first = await f.hub.store.session('import-project-a', 'alice')
  const second = await f.hub.store.session('import-project-b', 'alice')
  assert.ok(first.project_id)
  assert.equal(first.project_id, second.project_id)
  const project = await f.hub.store.project(first.project_id, 'alice')
  assert.equal(project.name, 'Example')
  assert.equal(project.workspace_key, 'd:/projects/example')
  assert.equal(project.manually_created, false)
  await upsert('import-project-a', 'D:\\Different\\Example')
  const moved = await f.hub.store.session('import-project-a', 'alice')
  assert.notEqual(moved.project_id, first.project_id)
  assert.equal(
    (await f.hub.store.project(moved.project_id, 'alice')).name,
    'Example (1)',
  )
  assert.equal(
    (await f.api(`/projects/${first.project_id}/sessions`)).body.sessions
      .length,
    1,
  )
  assert.equal(
    (await f.api(`/projects/${first.project_id}/sessions`, { token: 'bob' }))
      .status,
    404,
  )
})

test('real native PTY terminal uses selected device and closes its subscriptions', async (t) => {
  const f = await fixture(t)
  await f.hub.disconnect(f.connectorId)
  const device = new NativeDevice(
    f.root,
    (method, params) => f.hub.notify(f.connectorId, method, params),
    {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot || '',
      ComSpec: process.env.ComSpec || '',
    },
  )
  await f.hub.registerLocal(f.connectorId, device)
  const response = await f.api(
    `/connectors/${f.connectorId}/terminals-v2?root=${encodeURIComponent(f.root)}`,
    {
      method: 'POST',
      body: {
        label: 'integration',
        cols: 80,
        rows: 24,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        args: process.platform === 'win32' ? ['/D', '/Q'] : ['-i'],
      },
    },
  )
  assert.equal(response.status, 200)
  const terminalId = response.body.result.terminalId
  assert.equal(
    (
      await f.api(
        `/connectors/${f.connectorId}/terminals-v2/${terminalId}/resize`,
        { method: 'POST', body: { cols: 120, rows: 40 } },
      )
    ).status,
    200,
  )
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/connectors/${f.connectorId}/terminals-v2/${terminalId}/stream?token=alice`,
  )
  let output = ''
  let resolveMarker
  const marker = new Promise((resolve) => {
    resolveMarker = resolve
  })
  ws.on('message', (raw) => {
    const message = JSON.parse(raw)
    if (message.data) {
      output += Buffer.from(message.data, 'base64').toString()
      if (output.includes('NODE_PTY_VERIFIED')) resolveMarker()
    }
  })
  await once(ws, 'open')
  ws.send(
    JSON.stringify({
      type: 'input',
      data: Buffer.from('echo NODE_PTY_VERIFIED\r').toString('base64'),
    }),
  )
  let timeout
  await Promise.race([
    marker,
    new Promise(
      (_, reject) =>
        (timeout = setTimeout(
          () => reject(new Error('PTY output timeout')),
          10000,
        )),
    ),
  ]).finally(() => clearTimeout(timeout))
  assert.ok(output.includes('NODE_PTY_VERIFIED'))
  ws.close()
  await once(ws, 'close')
  const close = await f.api(
    `/connectors/${f.connectorId}/terminals-v2/${terminalId}`,
    { method: 'DELETE' },
  )
  assert.equal(close.status, 200)
  assert.equal(
    (
      await f.api(
        `/connectors/${f.connectorId}/terminals-v2/${terminalId}/snapshot`,
        { token: 'bob' },
      )
    ).status,
    404,
  )
})

test('concurrent session creation retries reserve one durable session and do not resend the task', async (t) => {
  const f = await fixture(t)
  const payload = {
    connectorId: f.connectorId,
    projectId: f.projectId,
    runtime: 'dsh',
    content: 'exactly once',
    clientMessageId: 'retry-id',
  }
  const before = f.calls.filter(
    (call) => call.method === 'session.create',
  ).length
  const results = await Promise.all([
    f.api('/sessions/create-and-start', { method: 'POST', body: payload }),
    f.api('/sessions/create-and-start', { method: 'POST', body: payload }),
  ])
  const accepted = results.find((result) => result.status === 200)
  assert.ok(accepted)
  for (const result of results) {
    if (result.status === 200)
      assert.equal(result.body.session.id, accepted.body.session.id)
    else {
      assert.equal(result.status, 409)
      assert.match(result.body.detail, /pending|unknown/)
    }
  }
  assert.equal(
    f.calls.filter((call) => call.method === 'session.create').length,
    before + 1,
  )
  const repeat = await f.api('/sessions/create-and-start', {
    method: 'POST',
    body: payload,
  })
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.session.id, accepted.body.session.id)
  assert.equal(
    (
      await f.api('/sessions/create-and-start', {
        method: 'POST',
        body: { ...payload, content: 'different' },
      })
    ).status,
    409,
  )
  const page = await f.api('/sessions?limit=1')
  assert.equal(page.body.hasMore, true)
  const next = await f.api(
    `/sessions?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`,
  )
  assert.notEqual(next.body.sessions[0].id, page.body.sessions[0].id)
})

test('runtime refusal is an actionable API error and never masquerades as a running task', async (t) => {
  const f = await fixture(t)
  await f.hub.disconnect(f.connectorId)
  await f.hub.registerLocal(f.connectorId, {
    call: async () => ({
      ok: false,
      code: 'INVALID_PARAMS',
      message: 'choose permissions',
    }),
  })
  const result = await f.api('/sessions/create-and-start', {
    method: 'POST',
    body: {
      connectorId: f.connectorId,
      projectId: f.projectId,
      runtime: 'dsh',
      content: 'test refusal',
      clientMessageId: 'refusal',
    },
  })
  assert.equal(result.status, 422)
  assert.match(result.body.detail, /choose permissions/)
  const rows = await f.db.query('SELECT status FROM sessions WHERE id<>$1', [
    f.sessionId,
  ])
  assert.equal(rows[0].status, 'error')
})

test('session writes require takeover, active runtime and mutable source; Agent target identity is server controlled', async (t) => {
  const f = await fixture(t)
  const route = `/sessions/${f.sessionId}/runtime/messages`
  await f.db.query('UPDATE sessions SET takeover=0 WHERE id=$1', [f.sessionId])
  assert.equal(
    (await f.api(route, { method: 'POST', body: { content: 'blocked' } }))
      .status,
    409,
  )
  await f.api(`/sessions/${f.sessionId}/takeover`, { method: 'POST' })
  await f.db.query(
    "UPDATE device_runtimes SET status='stopped' WHERE connector_id=$1",
    [f.connectorId],
  )
  assert.equal(
    (await f.api(route, { method: 'POST', body: { content: 'blocked' } }))
      .status,
    409,
  )
  await f.db.query(
    "UPDATE device_runtimes SET status='running' WHERE connector_id=$1",
    [f.connectorId],
  )
  await f.db.query('UPDATE sessions SET archived=1 WHERE id=$1', [f.sessionId])
  assert.equal(
    (await f.api(route, { method: 'POST', body: { content: 'blocked' } }))
      .status,
    409,
  )
  const forged = await f.api('/connectors', {
    method: 'POST',
    body: { name: 'forged', executorKind: 'server-agent' },
  })
  assert.equal(forged.body.connector.executorKind, 'desktop')
  await f.db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [f.connectorId],
  )
  const project = await f.api('/projects', {
    method: 'POST',
    body: {
      connectorId: f.connectorId,
      name: 'escape',
      workspacePath: path.dirname(f.root),
    },
  })
  assert.ok([403, 409, 422].includes(project.status))
})

test('S3 compatibility keeps the previous binary and metadata keys with signed requests', async (t) => {
  const objects = new Map()
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    })
    const key = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'PUT') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      objects.set(key, Buffer.concat(chunks))
      response.writeHead(200)
      response.end()
    } else {
      const data = objects.get(key)
      response.writeHead(data ? 200 : 404, {
        'content-type': 'application/octet-stream',
      })
      response.end(data)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const storage = createFileStorage('unused', {
    AGENT_SERVER_FILES_BACKEND: 's3',
    AGENT_SERVER_FILES_S3_BUCKET: 'synthetic-bucket',
    AGENT_SERVER_FILES_S3_PREFIX: 'existing-prefix',
    AGENT_SERVER_FILES_S3_ENDPOINT_URL: `http://127.0.0.1:${server.address().port}`,
    AGENT_SERVER_FILES_S3_ACCESS_KEY: 'synthetic-access',
    AGENT_SERVER_FILES_S3_SECRET_KEY: 'synthetic-secret',
  })
  t.after(async () => {
    storage.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  await storage.write('ses_a', 'file_b', Buffer.from('blob'), {
    name: 'owned.txt',
    mediaType: 'text/plain',
  })
  const result = await storage.read('ses_a', 'file_b')
  assert.equal(result.data.toString(), 'blob')
  assert.equal(result.metadata.name, 'owned.txt')
  assert.deepEqual([...objects.keys()].sort(), [
    '/synthetic-bucket/existing-prefix/ses_a/file_b.bin',
    '/synthetic-bucket/existing-prefix/ses_a/file_b.json',
  ])
  assert.equal(requests.length, 4)
  assert.ok(
    requests.every((request) =>
      request.authorization.startsWith('AWS4-HMAC-SHA256 '),
    ),
  )
})

test('legacy /workspace is mapped only for the authenticated managed server Agent', async (t) => {
  const f = await fixture(t)
  const body = {
    connectorId: f.connectorId,
    projectId: f.projectId,
    runtime: 'dsh',
    runtimeId: 'dsh',
    cwd: '/workspace',
    content: 'legacy Android request',
  }
  const create = (changes = {}, token = 'alice') =>
    f.api('/sessions/create-and-start', {
      method: 'POST',
      token,
      body: { ...body, ...changes },
    })
  assert.equal((await create()).status, 422)
  await f.db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [f.connectorId],
  )
  assert.equal((await create()).status, 403)
  await f.db.query(
    'INSERT INTO server_agents(owner_user_id,connector_id,runtime_id,project_id,credential_ciphertext,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
    [
      'alice',
      f.connectorId,
      'dsh',
      f.projectId,
      'synthetic',
      new Date().toISOString(),
    ],
  )
  const result = await create({ clientMessageId: 'legacy-managed-alias' })
  assert.equal(result.status, 200)
  assert.equal(result.body.session.cwd, f.root)
  assert.equal(f.calls.at(-1).method, 'session.create')
  assert.equal(f.calls.at(-1).params.cwd, f.root)
  assert.equal(
    (await f.hub.store.session(result.body.session.id, 'alice')).cwd,
    f.root,
  )
  const rpcCount = f.calls.filter(
    (call) => call.method === 'session.create',
  ).length
  assert.equal(
    (await create({ clientMessageId: 'legacy-managed-alias', cwd: f.root }))
      .status,
    200,
  )
  assert.equal(
    f.calls.filter((call) => call.method === 'session.create').length,
    rpcCount,
  )
  for (const cwd of [
    '/workspace/../another-user',
    '/etc',
    path.dirname(f.root),
  ])
    assert.equal((await create({ cwd })).status, 422)
  assert.equal((await create({}, 'bob')).status, 404)
  assert.equal((await create({ runtimeId: 'different' })).status, 403)
  await f.db.query(
    'UPDATE server_agents SET project_id=NULL WHERE owner_user_id=$1',
    ['alice'],
  )
  assert.equal((await create()).status, 403)
})

for (const [os, workspace, equivalent, different] of [
  [
    'win32',
    'D:\\项目\\Agent Space\\workspace',
    'd:/项目/agent space/workspace/',
    'D:\\项目\\Other',
  ],
  [
    'linux',
    '/srv/用户/Agent Space/workspace',
    '/srv/用户/Agent Space/./workspace/',
    '/srv/用户/agent space/workspace',
  ],
])
  test(`managed ${os} projections retain the bound project across legacy duplicate paths`, async (t) => {
    const f = await fixture(t)
    const now = new Date().toISOString()
    await f.db.query(
      "UPDATE connectors SET executor_kind='server-agent',device_os=$2 WHERE id=$1",
      [f.connectorId, os],
    )
    await f.db.query(
      'UPDATE projects SET workspace_path=$2,workspace_key=$3 WHERE id=$1',
      [f.projectId, workspace, `legacy-raw:${workspace}`],
    )
    await f.db.query(
      'INSERT INTO server_agents(owner_user_id,connector_id,runtime_id,project_id,credential_ciphertext,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
      ['alice', f.connectorId, 'dsh', f.projectId, 'synthetic', now],
    )
    await f.db.query(
      'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
      [
        'duplicate-projection',
        'alice',
        f.connectorId,
        'Duplicate preserved',
        equivalent,
        'normalized-old-duplicate',
        now,
      ],
    )
    await f.db.query('UPDATE sessions SET project_id=$2,cwd=$3 WHERE id=$1', [
      f.sessionId,
      'duplicate-projection',
      equivalent,
    ])
    const projectCount = (await f.db.query('SELECT id FROM projects')).length
    const project = async (id, cwd, runtimeId = 'dsh') =>
      f.db.transaction((connection) =>
        f.hub.store.ingestSession(connection, f.connectorId, {
          sessionId: id,
          runtime: 'dsh',
          runtimeId,
          cwd,
        }),
      )
    for (const cwd of [equivalent, workspace, '/workspace']) {
      const row = await project(f.sessionId, cwd)
      assert.equal(row.project_id, f.projectId)
      assert.equal(row.cwd, workspace)
    }
    const imported = await project('new-history', equivalent)
    assert.equal(imported.project_id, f.projectId)
    const requestedProject = await f.api('/projects', {
      method: 'POST',
      body: {
        connectorId: f.connectorId,
        name: 'Must reuse managed workspace',
        workspacePath: equivalent,
      },
    })
    assert.equal(requestedProject.status, 200)
    assert.equal(requestedProject.body.project.id, f.projectId)
    assert.equal(
      (await f.db.query('SELECT id FROM projects')).length,
      projectCount,
    )
    assert.ok(await f.hub.store.project('duplicate-projection', 'alice'))
    const accepted = await f.api('/sessions/create-and-start', {
      method: 'POST',
      body: {
        connectorId: f.connectorId,
        projectId: f.projectId,
        runtime: 'dsh',
        cwd: equivalent,
        content: 'normalized managed request',
      },
    })
    assert.equal(accepted.status, 200)
    assert.equal(f.calls.at(-1).params.cwd, workspace)
    await assert.rejects(
      project('wrong-runtime', workspace, 'other-runtime'),
      (error) => error.status === 403,
    )
    await assert.rejects(
      project('wrong-path', different),
      (error) => error.status === 403,
    )
    await assert.rejects(
      project('path-escape', `${workspace}/../other`),
      (error) => error.status === 403,
    )
    const body = {
      connectorId: f.connectorId,
      projectId: 'duplicate-projection',
      runtime: 'dsh',
      content: 'must not run',
    }
    assert.equal(
      (await f.api('/sessions/create-and-start', { method: 'POST', body }))
        .status,
      403,
    )
    assert.equal(
      (
        await f.api('/sessions/create-and-start', {
          method: 'POST',
          body: { ...body, projectId: f.projectId },
          token: 'bob',
        })
      ).status,
      404,
    )
    await f.db.query("UPDATE projects SET user_id='bob' WHERE id=$1", [
      f.projectId,
    ])
    await assert.rejects(
      project('wrong-owner', workspace),
      (error) => error.status === 403,
    )
  })

test('session creation receipts distinguish accepted, rejected, pending and unconfirmed results without replay', async (t) => {
  const f = await fixture(t)
  const originalCall = f.local.call
  const attempts = new Map()
  let releasePending
  let pendingEntered
  const pendingReady = new Promise((resolve) => {
    pendingEntered = resolve
  })
  f.local.call = async (method, params) => {
    if (method !== 'session.create') return originalCall(method, params)
    const message = params.clientMessageId
    attempts.set(message, (attempts.get(message) || 0) + 1)
    if (message === 'rejected')
      return { ok: false, message: 'Model selection is invalid' }
    if (message === 'unconfirmed')
      throw new Error('synthetic private transport details')
    if (message === 'pending' && attempts.get(message) === 1) {
      pendingEntered()
      await new Promise((resolve) => {
        releasePending = resolve
      })
    }
    return originalCall(method, params)
  }
  const body = {
    connectorId: f.connectorId,
    projectId: f.projectId,
    runtime: 'dsh',
    content: 'hello',
  }
  const create = (clientMessageId, changes = {}, token = 'alice') =>
    f.api('/sessions/create-and-start', {
      method: 'POST',
      token,
      body: { ...body, clientMessageId, ...changes },
    })
  const receiptKey = (id, owner = 'alice', connector = f.connectorId) =>
    `session-create:${hashToken(`${owner}:${connector}:${id}`)}`
  const receipt = async (id) =>
    JSON.parse(
      (
        await f.db.query('SELECT value FROM instance_settings WHERE key=$1', [
          receiptKey(id),
        ])
      )[0].value,
    )
  const firstFailure = await create('rejected')
  assert.equal(firstFailure.status, 422)
  assert.deepEqual(await create('rejected'), firstFailure)
  assert.equal(attempts.get('rejected'), 1)
  assert.equal((await receipt('rejected')).state, 'rejected')
  const pending = create('pending')
  await pendingReady
  const concurrent = await create('pending')
  assert.equal(concurrent.status, 409)
  assert.equal(concurrent.body.code, 'session_create_outcome_unknown')
  assert.equal(concurrent.body.sessionId, (await receipt('pending')).sessionId)
  assert.match(concurrent.body.detail, /outcome is unknown/)
  assert.equal(attempts.get('pending'), 1)
  releasePending()
  const accepted = await pending
  assert.equal(accepted.status, 200)
  const repeated = await create('pending')
  assert.equal(repeated.status, 200)
  assert.equal(repeated.body.session.id, accepted.body.session.id)
  assert.deepEqual(repeated.body.connectorResult, accepted.body.connectorResult)
  assert.equal(attempts.get('pending'), 1)
  assert.equal((await receipt('pending')).state, 'accepted')
  assert.equal((await create('pending', { content: 'different' })).status, 409)
  const unavailable = await create('unconfirmed')
  assert.equal(unavailable.status, 409)
  assert.equal(unavailable.body.code, 'session_create_outcome_unknown')
  assert.equal(
    unavailable.body.sessionId,
    (await receipt('unconfirmed')).sessionId,
  )
  assert.doesNotMatch(unavailable.body.detail, /private transport/)
  const unresolved = await create('unconfirmed')
  assert.equal(unresolved.status, 409)
  assert.equal(unresolved.body.code, 'session_create_outcome_unknown')
  assert.equal((await receipt('unconfirmed')).state, 'pending')
  assert.equal(attempts.get('unconfirmed'), 1)
  const missingFile = {
    attachments: [{ id: 'missing-owned-file', name: 'missing.txt' }],
  }
  const staging = await create('staging-failure', missingFile)
  assert.ok(staging.status >= 400)
  assert.deepEqual(await create('staging-failure', missingFile), staging)
  assert.equal(attempts.has('staging-failure'), false)
  assert.equal((await receipt('staging-failure')).state, 'rejected')
  const legacy = await receipt('pending')
  delete legacy.state
  legacy.fingerprint = 'previous-release-fingerprint'
  await f.db.query('UPDATE instance_settings SET value=$2 WHERE key=$1', [
    receiptKey('pending'),
    JSON.stringify(legacy),
  ])
  const unknownLegacy = await create('pending')
  assert.equal(
    unknownLegacy.status,
    409,
    'legacy idle/session data is not an acceptance receipt',
  )
  assert.equal(unknownLegacy.body.code, 'session_create_outcome_unknown')
  assert.equal(attempts.get('pending'), 1)
  const otherConnector = (
    await f.api('/connectors', {
      method: 'POST',
      token: 'bob',
      body: { name: 'Bob desktop', connectorKind: 'desktop' },
    })
  ).body.connector.id
  await f.hub.registerLocal(otherConnector, f.local)
  await f.hub.discover(otherConnector)
  await f.db.query(
    "UPDATE device_runtimes SET config_json='{}',active=1,status='running' WHERE connector_id=$1",
    [otherConnector],
  )
  const otherProject = (
    await f.api('/projects', {
      method: 'POST',
      token: 'bob',
      body: {
        name: 'Bob project',
        connectorId: otherConnector,
        workspacePath: f.root,
      },
    })
  ).body.project.id
  const other = await create(
    'pending',
    { connectorId: otherConnector, projectId: otherProject },
    'bob',
  )
  assert.equal(other.status, 200)
  assert.notEqual(other.body.session.id, accepted.body.session.id)
  assert.equal(
    (
      await f.db.query('SELECT key FROM instance_settings WHERE key=$1', [
        receiptKey('pending', 'bob', otherConnector),
      ])
    ).length,
    1,
  )
})

test('permission downgrade closes idle streams and invalidates unconsumed tickets immediately', async (t) => {
  const f = await fixture(t)
  const getTicket = () =>
    f.api('/ws-ticket', {
      method: 'POST',
      body: { clientId: 'client', scope: { sessionId: f.sessionId } },
    })
  const first = await getTicket()
  const second = await getTicket()
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v2/sessions/${f.sessionId}/ws?ticket=${first.body.ticket}`,
  )
  await once(ws, 'open')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const closed = once(ws, 'close')
  f.accounts.get('alice').permissions = ['devices.read']
  await f.hub.revalidateUser('alice')
  assert.equal((await closed)[0], 1008)
  await assert.rejects(
    f.hub.consumeTicket(second.body.ticket, f.sessionId),
    /invalid WebSocket ticket/,
  )
  assert.equal(f.hub.isOnline(f.connectorId), true)
})

test('inventory scans fence stale observations, resolve external IDs, and import source archives once', async (t) => {
  const f = await fixture(t)
  const scan = (token) => ({
    runtime: 'dsh',
    runtimeId: 'dsh',
    scanToken: token,
  })
  const old = 'old-scan-1234567890',
    current = 'new-scan-1234567890'
  await f.hub.notify(f.connectorId, 'session.inventory.begin', scan(old))
  await f.hub.notify(f.connectorId, 'session.inventory.begin', scan(current))
  await f.hub.notify(f.connectorId, 'session.inventory.complete', {
    ...scan(old),
    complete: true,
    sessions: [],
  })
  assert.notEqual(
    (await f.api(`/sessions/${f.sessionId}/meta`)).body.session
      .sourceAvailability,
    'missing',
  )
  await f.hub.notify(f.connectorId, 'session.inventory.complete', {
    ...scan(current),
    complete: true,
    sessions: [
      {
        sessionId: 'native-other-name',
        externalSessionId: 'native-1',
        sourceState: { availability: 'archived' },
      },
    ],
  })
  const archived = (await f.api(`/sessions/${f.sessionId}/meta`)).body.session
  assert.equal(archived.sourceAvailability, 'archived')
  assert.equal(archived.archived, true)
  await f.api('/sessions/unarchive', { method: 'POST', body: [f.sessionId] })
  await f.hub.notify(f.connectorId, 'session.source.updated', {
    sessionId: f.sessionId,
    runtime: 'dsh',
    runtimeId: 'dsh',
    availability: 'archived',
  })
  assert.equal(
    (await f.api(`/sessions/${f.sessionId}/meta`)).body.session.archived,
    false,
  )
  await f.hub.notify(
    f.connectorId,
    'session.inventory.begin',
    scan('last-scan-1234567890'),
  )
  await f.hub.notify(f.connectorId, 'session.inventory.complete', {
    ...scan('last-scan-1234567890'),
    complete: true,
    sessions: [],
  })
  assert.equal(
    (await f.api(`/sessions/${f.sessionId}/meta`)).body.session
      .sourceAvailability,
    'missing',
  )
})

test('runtime errors and capabilities preserve native protocol shape and block unsupported actions', async (t) => {
  const f = await fixture(t)
  await f.hub.notify(f.connectorId, 'runtime.error', {
    sessionId: f.sessionId,
    runtime: 'dsh',
    runtimeId: 'dsh',
    message: 'model unavailable',
  })
  const notice = f.hub.notices
    .get(f.sessionId)
    .get(`runtime_error_${f.sessionId}`)
  assert.equal(notice.message, 'model unavailable')
  assert.equal(notice.type, 'notification')
  const capability = {
    capabilityId: 'session.send_message',
    scope: 'runtime',
    runtime: 'dsh',
    runtimeId: 'dsh',
    supported: true,
    available: true,
    allowed: true,
  }
  await f.hub.notify(f.connectorId, 'protocol.capabilitiesUpdated', {
    revision: 1,
    capabilities: [capability],
  })
  await f.hub.notify(f.connectorId, 'runtime.capability.updated', {
    revision: 2,
    capabilities: [{ ...capability, capabilityId: 'catalog.model' }],
  })
  const [stored] = await f.db.query(
    'SELECT capabilities_json FROM connector_protocol_capabilities WHERE connector_id=$1',
    [f.connectorId],
  )
  assert.equal(JSON.parse(stored.capabilities_json).capabilities.length, 2)
  await f.hub.disconnect(f.connectorId)
  await f.hub.registerLocal(f.connectorId, {
    call: async (method) =>
      method === 'session.capabilities'
        ? {
            capabilitySet: {
              revision: 3,
              capabilities: [{ ...capability, available: false }],
            },
          }
        : { state: { status: 'idle' } },
  })
  const response = await f.api(`/sessions/${f.sessionId}/runtime/messages`, {
    method: 'POST',
    body: { content: 'must not execute' },
  })
  assert.equal(response.status, 409)
  assert.match(response.body.detail, /capability is unavailable/)
})

test('inline attachments validate encoding, bytes and integrity before being forwarded', async (t) => {
  const f = await fixture(t)
  for (const patch of [
    { contentBase64: '!!!=' },
    { size: 9 },
    { sha256: '0'.repeat(64) },
  ]) {
    await assert.rejects(
      f.files.stage('alice', f.sessionId, [
        {
          fileId: 'file_bad',
          name: 'bad.txt',
          contentBase64: 'YQ==',
          ...patch,
        },
      ]),
      (error) => error.status === 422,
    )
  }
  const staged = await f.files.stage('alice', f.sessionId, [
    { fileId: 'file_good', name: 'good.txt', contentBase64: 'YQ==', size: 1 },
  ])
  assert.equal(
    staged[0].downloadUrl,
    `/api/v2/connector/sessions/${f.sessionId}/attachments/file_good/content`,
  )
  assert.ok(!('contentBase64' in staged[0]))
})
