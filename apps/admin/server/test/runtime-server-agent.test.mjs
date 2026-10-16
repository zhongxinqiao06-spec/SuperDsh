import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import WebSocket from 'ws'
import { parseProtocolEvent } from '../../src/components/session/protocol-event.ts'
import { IdentityService } from '../identity/service.ts'
import { ConnectorHub } from '../devices/connector-hub.ts'
import { ModelService } from '../models/model-service.ts'
import { ModelProxy } from '../models/model-routes.ts'
import {
  ServerAgentService,
  registerServerAgentRoutes,
} from '../runtime/server-agents.ts'
import { ApiRouter } from '../http/api-router.ts'
import { createPlatformServer } from '../http/platform-server.ts'
import { registerConversationRoutes } from '../conversations/routes.ts'
import { withTestDatabase } from './support/database.mjs'
import { workspaceIdentity } from '../conversations/workspace.ts'

async function until(operation, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (!(await operation())) {
    if (Date.now() > end) throw new Error(`${label} timed out`)
    await delay(50)
  }
}
async function fixture(t, adapter) {
  let cleanDatabase
  const db = await withTestDatabase({
    after: (callback) => {
      cleanDatabase = callback
    },
  })
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superdsh-host-中文-'))
  const identity = new IdentityService(db, { secret: 'synthetic-login-key' })
  await identity.seedBuiltinRoles()
  const now = new Date().toISOString()
  for (const id of ['alice', 'bob'])
    await db.query(
      "INSERT INTO users(id,username,password_hash,role,display_name,created_at,updated_at) VALUES($1,$1,'synthetic-unused','member',$1,$2,$2)",
      [id, now],
    )
  const hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-connector-key',
    getUser: (id) => identity.getUser(id),
    authenticateToken: async (token) => {
      const user = await identity.authenticateToken(token)
      if (!user) throw new Error('not authenticated')
      return user
    },
  })
  const models = new ModelService({
    db,
    encryptionKey: randomBytes(32).toString('base64url'),
    audit: (...args) => identity.audit(...args),
  })
  const proxy = new ModelProxy({
    models,
    auth: {
      getAccount: (id) => identity.getUser(id),
      authenticateConnector: (token) => hub.authenticateConnector(token),
      connectorAllowed: async (id, owner, hash) => {
        try {
          const row = await hub.connectorAllowed(id)
          return row.user_id === owner && (!hash || row.token_hash === hash)
        } catch {
          return false
        }
      },
    },
  })
  const service = new ServerAgentService({
    db,
    rootDirectory,
    hub,
    models,
    proxy,
    getAccount: (id) => identity.getUser(id),
    audit: (...args) => identity.audit(...args),
    adapter,
  })
  service.startWatchdog()
  t.after(async () => {
    try {
      await service.close()
      await hub.close()
    } finally {
      await cleanDatabase()
      assert.equal(dirname(resolve(rootDirectory)), resolve(tmpdir()))
      assert.ok(rootDirectory.includes('superdsh-host-中文-'))
      await rm(rootDirectory, { recursive: true, force: true })
    }
  })
  return { db, identity, hub, models, proxy, service, rootDirectory }
}

test('native Agent binding is stable, uses owned workspace and preserves block/revocation admission', async (t) => {
  const contexts = []
  let resolveExit
  const runtime = await fixture(t, {
    async start(context) {
      contexts.push(context)
      return {
        ready: Promise.resolve({ hostReady: true, connectorReady: true }),
        exited: new Promise((resolve) => {
          resolveExit = resolve
        }),
        stop: async () => resolveExit({ code: 0, signal: null }),
      }
    },
  })
  const results = await Promise.all([
    runtime.service.prepare('alice'),
    runtime.service.prepare('alice'),
  ])
  assert.equal(results[0].connectorId, results[1].connectorId)
  await until(() => contexts.length === 1, 'single preparation')
  const [binding] = await runtime.db.query(
    'SELECT a.*,p.workspace_path,p.workspace_key FROM server_agents a JOIN projects p ON p.id=a.project_id WHERE a.owner_user_id=$1',
    ['alice'],
  )
  assert.equal(binding.workspace_path, contexts[0].paths.workspace)
  assert.equal(
    binding.workspace_key,
    workspaceIdentity(binding.workspace_path).key,
  )
  assert.equal(
    contexts[0].host.environment.SUPERDSH_MODEL_ENCRYPTION_KEY,
    undefined,
  )
  assert.equal(
    (
      await runtime.db.query('SELECT id FROM connectors WHERE user_id=$1', [
        'alice',
      ])
    ).length,
    1,
  )
  await runtime.db.query(
    'UPDATE connectors SET connection_blocked_at=$2 WHERE id=$1',
    [binding.connector_id, new Date().toISOString()],
  )
  await runtime.service.revoke('alice')
  await assert.rejects(runtime.service.prepare('alice'), /blocked/)
  assert.equal((await runtime.service.view('alice')).status, 'stopped')
  assert.equal((await runtime.service.view('bob')).connectorId, null)
})

test('native preparation repairs duplicate projection associations without deleting projects or crossing runtime ownership', async (t) => {
  const contexts = []
  const runtime = await fixture(t, {
    async start(context) {
      contexts.push(context)
      let exited
      return {
        ready: Promise.resolve({ hostReady: true, connectorReady: true }),
        exited: new Promise((resolveExit) => {
          exited = resolveExit
        }),
        stop: async () => exited({ code: 0, signal: null }),
      }
    },
  })
  await runtime.service.prepare('alice')
  await runtime.service.prepare('bob')
  await until(
    async () =>
      (
        await runtime.db.query(
          "SELECT * FROM server_agents WHERE status='running'",
        )
      ).length === 2,
    'prepared bindings',
  )
  const [binding] = await runtime.db.query(
    "SELECT a.*,p.workspace_path,p.workspace_key FROM server_agents a JOIN projects p ON p.id=a.project_id WHERE a.owner_user_id='alice'",
  )
  const [other] = await runtime.db.query(
    "SELECT a.*,p.workspace_key FROM server_agents a JOIN projects p ON p.id=a.project_id WHERE a.owner_user_id='bob'",
  )
  const now = new Date().toISOString()
  const key = workspaceIdentity(binding.workspace_path).key
  await runtime.db.query('UPDATE projects SET workspace_key=$2 WHERE id=$1', [
    binding.project_id,
    `old-raw:${binding.workspace_path}`,
  ])
  await runtime.db.query(
    'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,pinned,manually_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,false,$7,$7)',
    [
      'duplicate',
      'alice',
      binding.connector_id,
      'Keep original title',
      binding.workspace_path,
      key,
      now,
    ],
  )
  await runtime.db.query(
    'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,manually_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$7)',
    [
      'unrelated',
      'alice',
      binding.connector_id,
      'Other workspace',
      join(binding.workspace_path, 'other'),
      `${key}/other`,
      now,
    ],
  )
  for (const [id, runtimeId, projectId, cwd] of [
    ['duplicated-history', 'dsh', 'duplicate', binding.workspace_path],
    ['legacy-history', 'dsh', binding.project_id, '/workspace'],
    ['other-runtime', 'another-runtime', 'duplicate', binding.workspace_path],
    [
      'other-workspace',
      'dsh',
      'unrelated',
      join(binding.workspace_path, 'other'),
    ],
  ])
    await runtime.db.query(
      "INSERT INTO sessions(id,connector_id,project_id,runtime,runtime_id,cwd,status,takeover,seq,updated_seq,created_at,updated_at,sort_at) VALUES($1,$2,$3,'dsh',$4,$5,'idle',0,0,0,$6,$6,$6)",
      [id, binding.connector_id, projectId, runtimeId, cwd, now],
    )
  const projectCount = (await runtime.db.query('SELECT id FROM projects'))
    .length
  await runtime.service.prepare('alice')
  await runtime.service.prepare('alice')
  assert.equal(contexts.length, 2, 'repair does not start another owned Host')
  const projects = await runtime.db.query('SELECT * FROM projects')
  assert.equal(projects.length, projectCount)
  assert.equal(
    projects.find((row) => row.id === binding.project_id).workspace_key,
    key,
  )
  const duplicate = projects.find((row) => row.id === 'duplicate')
  assert.equal(duplicate.name, 'Keep original title')
  assert.equal(duplicate.pinned, 1)
  assert.equal(duplicate.workspace_path, binding.workspace_path)
  assert.equal(duplicate.workspace_key, 'legacy-server-agent:duplicate')
  assert.equal(
    projects.find((row) => row.id === other.project_id).workspace_key,
    other.workspace_key,
  )
  const sessions = await runtime.db.query(
    'SELECT id,project_id,cwd FROM sessions ORDER BY id',
  )
  for (const id of ['duplicated-history', 'legacy-history']) {
    const row = sessions.find((item) => item.id === id)
    assert.equal(row.project_id, binding.project_id)
    assert.equal(row.cwd, binding.workspace_path)
  }
  assert.equal(
    sessions.find((row) => row.id === 'other-runtime').project_id,
    'duplicate',
  )
  assert.equal(
    sessions.find((row) => row.id === 'other-workspace').project_id,
    'unrelated',
  )
})

test('legacy container binding cannot silently start an empty native Home or change its stored workspace', async (t) => {
  let starts = 0
  const runtime = await fixture(t, {
    start: async () => {
      starts++
      throw new Error('must not start')
    },
  })
  const now = new Date().toISOString()
  await runtime.db.query(
    "INSERT INTO connectors(id,user_id,name,connector_kind,executor_kind,device_os,status,token_hash,token_prefix,created_at,updated_at) VALUES('conn_legacy','alice','服务端 Agent','cli','server-agent','linux','offline','synthetic-hash','cxt_test',$1,$1)",
    [now],
  )
  await runtime.db.query(
    "INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,manually_created,created_at,updated_at) VALUES('project_legacy','alice','conn_legacy','服务端工作区','/workspace','/workspace',false,$1,$1)",
    [now],
  )
  await runtime.db.query(
    "INSERT INTO server_agents(owner_user_id,connector_id,runtime_id,project_id,credential_ciphertext,created_at,updated_at) VALUES('alice','conn_legacy','dsh','project_legacy','opaque-existing-cipher',$1,$1)",
    [now],
  )
  await assert.rejects(
    runtime.service.prepare('alice'),
    (error) =>
      error.status === 409 &&
      error.message.includes('旧版服务端 Agent 数据') &&
      error.message.includes('server:import-agent-data') &&
      !error.message.includes('alice') &&
      !error.message.includes(runtime.rootDirectory),
  )
  assert.equal(starts, 0)
  const [row] = await runtime.db.query(
    "SELECT a.credential_ciphertext,p.workspace_path FROM server_agents a JOIN projects p ON p.id=a.project_id WHERE a.owner_user_id='alice'",
  )
  assert.equal(row.workspace_path, '/workspace')
  assert.equal(row.credential_ciphertext, 'opaque-existing-cipher')
  assert.deepEqual(await readdir(runtime.rootDirectory), [])
})

test(
  'real full Host + Node Connector + API v2 + PostgreSQL reaches local streaming model without Python',
  { timeout: 180_000 },
  async (t) => {
    const runtime = await fixture(t)
    let modelRequests = 0
    let toolReadSeen = false
    let cancelPending = false
    let cancelClosed = false
    let approvalExecuted = false
    let approvalCalls = 0
    let approvalToolResult = ''
    let releaseFirstReply
    const firstReplyGate = new Promise((resolve) => {
      releaseFirstReply = resolve
    })
    t.after(() => releaseFirstReply())
    const upstream = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      assert.equal(body.model, 'synthetic-model')
      assert.equal(
        request.headers.authorization,
        'Bearer synthetic-provider-key',
      )
      modelRequests++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const messages = Array.isArray(body.messages) ? body.messages : []
      if (
        JSON.stringify(messages).includes('Reply with the connectivity marker.')
      )
        await firstReplyGate
      const canRead = body.tools?.some((tool) => tool.function?.name === 'read')
      const wantsRead =
        canRead &&
        messages.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes(
              'Read fixture read-fixture.txt',
            ),
        )
      const wantsCancel =
        canRead &&
        messages.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes(
              'Wait for cancellation test',
            ),
        )
      const wantsApproval =
        canRead &&
        messages.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes(
              'Exercise one approval request',
            ),
        )
      if (wantsApproval)
        approvalToolResult = JSON.stringify(
          messages.filter((message) => message.role === 'tool'),
        ).slice(-2500)
      if (
        wantsApproval &&
        !messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('APPROVAL_EXECUTED'),
        )
      ) {
        if (++approvalCalls > 2) {
          response.end('data: [DONE]\n\n')
          return
        }
        const tool = body.tools.find(
          (tool) =>
            tool.function?.parameters?.properties?.command &&
            tool.function?.parameters?.properties?.sandbox_permissions?.enum?.includes(
              'danger-full-access',
            ),
        )
        assert.ok(
          tool,
          'real full Host must expose a shell with approval capability',
        )
        const command = tool.function.name.includes('pwsh')
          ? "Write-Output 'APPROVAL_EXECUTED'"
          : "printf 'APPROVAL_EXECUTED'"
        response.write(
          `data: ${JSON.stringify({ id: 'approval-fixture', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'approval-tool-one', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ command, description: 'Print isolated approval test marker', sandbox_permissions: 'danger-full-access', justification: 'Exercise approval transport for a harmless marker in the temporary test workspace.' }) } }] }, finish_reason: null }] })}\n\n`,
        )
        response.write(
          'data: {"id":"approval-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        )
        response.end('data: [DONE]\n\n')
        return
      }
      if (wantsApproval) approvalExecuted = true
      if (wantsCancel) {
        cancelPending = true
        response.write(
          'data: {"id":"cancel-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"waiting"},"finish_reason":null}]}\n\n',
        )
        response.once('close', () => {
          cancelClosed = true
        })
        return
      }
      if (
        wantsRead &&
        !messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('OWNED_WORKSPACE_READ_OK'),
        )
      ) {
        response.write(
          `data: ${JSON.stringify({ id: 'read-fixture', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-tool-one', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'read-fixture.txt' }) } }] }, finish_reason: null }] })}\n\n`,
        )
        response.write(
          'data: {"id":"read-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        )
        response.end('data: [DONE]\n\n')
        return
      }
      if (wantsRead) toolReadSeen = true
      for (const chunk of [
        {
          id: 'synthetic-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'synthetic-model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: wantsApproval
                  ? 'NODE_APPROVAL_LINK_OK'
                  : wantsRead
                    ? 'NODE_TOOL_LINK_OK'
                    : 'NODE_HOST_LINK_OK',
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'synthetic-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'synthetic-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    t.after(async () => {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    })
    const provider = await runtime.models.save(
      {
        name: 'Synthetic test model',
        protocol: 'openai-completions',
        baseUrl: `http://127.0.0.1:${upstream.address().port}`,
        apiKey: 'synthetic-provider-key',
        models: [
          {
            modelId: 'synthetic-model',
            name: 'Synthetic model',
            maxTokens: 1024,
            contextWindow: 32768,
          },
        ],
      },
      'alice',
    )
    await runtime.models.setDefault(
      { providerId: provider.providerId, modelId: 'synthetic-model' },
      'alice',
    )
    const router = new ApiRouter(async (request) =>
      runtime.identity.getUser(
        request.headers['x-test-user'] === 'bob' ? 'bob' : 'alice',
      ),
    )
    registerServerAgentRoutes(router, runtime.service)
    registerConversationRoutes(router, runtime.hub)
    const platform = createPlatformServer({
      api: router.handle,
      apiUpgrade: (request, socket, head) =>
        runtime.hub.handleUpgrade(request, socket, head),
      web: (_request, response) => response.end(),
      port: 0,
    })
    const address = await platform.start()
    t.after(() => platform.close())
    const origin = `http://127.0.0.1:${address.port}/api/v2`
    const preparation = await fetch(`${origin}/server-agent`, {
      method: 'POST',
      body: '{}',
    })
    assert.equal(preparation.status, 200)
    const { agent } = await preparation.json()
    await until(
      async () => {
        const current = await runtime.service.view('alice')
        if (current.status === 'error')
          throw new Error(`Full Host startup failed: ${current.error}`)
        return current.status === 'running'
      },
      'full Host readiness',
      130_000,
    )
    const catalog = await runtime.models.catalog('alice')
    const model = `dsh:model:${Buffer.from(JSON.stringify([`superdsh-${catalog.scope}-${provider.providerId}`, 'synthetic-model', null])).toString('base64url')}`
    const permissions = await runtime.hub.call(
      agent.connectorId,
      'runtime.permissionCatalog',
      { runtime: 'dsh', runtimeId: 'dsh' },
    )
    const permission = permissions.catalog.permissions.find(
      (item) => item.enabled !== false,
    ).selectionId
    const response = await fetch(`${origin}/sessions/create-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectorId: agent.connectorId,
        projectId: agent.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        content: 'Reply with the connectivity marker.',
        clientMessageId: 'native-e2e-one',
        selections: { model, permission },
      }),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    const sessionId = result.session.id
    const login = await runtime.identity.issueLogin(
      'alice',
      'Headless browser stream regression',
    )
    const wsTicket = runtime.hub.issueTicket(
      login.accessToken,
      'alice',
      'headless-session-stream',
      sessionId,
    )
    const received = []
    const invalidFrames = []
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/sessions/${sessionId}/ws?ticket=${wsTicket.ticket}`,
    )
    socket.on('message', (data) => {
      const raw = data.toString()
      if (JSON.parse(raw).type === 'keepalive') return
      const event = parseProtocolEvent(raw)
      if (event) received.push(event)
      else invalidFrames.push(raw)
    })
    t.after(() => socket.close())
    await once(socket, 'open')
    await until(
      () => received.some((event) => event.type === 'session.subscribed'),
      'browser accepts subscription',
    )
    await until(async () => {
      const replay = await (
        await fetch(`${origin}/sessions/${sessionId}/events?after=seq:0`)
      ).json()
      const replayed = replay.events.map((event) =>
        parseProtocolEvent(JSON.stringify(event)),
      )
      assert.ok(
        replayed.every(Boolean),
        'real frontend parser accepts reconnect events',
      )
      return replayed.some(
        (event) =>
          event.payload.item?.role === 'user' &&
          JSON.stringify(event.payload.item.content).includes(
            'Reply with the connectivity marker.',
          ),
      )
    }, 'browser recovers the submitted user message')
    releaseFirstReply()
    await until(
      () =>
        received.some(
          (event) =>
            event.payload.item?.role === 'assistant' &&
            event.payload.item.status === 'done' &&
            JSON.stringify(event.payload.item.content).includes(
              'NODE_HOST_LINK_OK',
            ),
        ) &&
        received.some(
          (event) =>
            event.type === 'runtime.state.updated' &&
            event.payload.state?.status === 'idle',
        ),
      'browser receives completed assistant and idle state',
      20000,
    )
    assert.deepEqual(
      invalidFrames,
      [],
      'no real Host session event may be silently discarded by the browser',
    )
    const socketClosed = once(socket, 'close')
    socket.close()
    await socketClosed
    await until(
      async () => {
        const timeline = await runtime.hub.store.timeline(sessionId)
        return JSON.stringify(timeline.items).includes('NODE_HOST_LINK_OK')
      },
      'stream projection',
      20000,
    ).catch(async (error) => {
      t.diagnostic(
        JSON.stringify({
          modelRequests,
          result,
          state: await runtime.hub.store.session(sessionId),
          timeline: await runtime.hub.store.timeline(sessionId),
        }),
      )
      throw error
    })
    // The full Host may separately generate a session title. Verify one user
    // turn in its native projection instead of mistaking that request for replay.
    assert.ok(modelRequests >= 1)
    const snapshot = await (
      await fetch(`${origin}/sessions/${sessionId}/snapshot`)
    ).json()
    assert.ok(JSON.stringify(snapshot).includes('NODE_HOST_LINK_OK'))
    assert.equal(
      snapshot.timeline.items.filter(
        (item) =>
          item.role === 'user' &&
          JSON.stringify(item).includes('Reply with the connectivity marker.'),
      ).length,
      1,
    )
    assert.equal(
      (
        await fetch(`${origin}/sessions/${sessionId}/snapshot`, {
          headers: { 'X-Test-User': 'bob' },
        })
      ).status,
      404,
    )
    assert.equal(
      JSON.stringify(snapshot).includes('synthetic-provider-key'),
      false,
    )
    const [project] = await runtime.db.query(
      'SELECT workspace_path FROM projects WHERE id=$1',
      [agent.projectId],
    )
    await writeFile(
      join(project.workspace_path, 'read-fixture.txt'),
      'OWNED_WORKSPACE_READ_OK\n',
    )
    const toolResponse = await fetch(`${origin}/sessions/create-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectorId: agent.connectorId,
        projectId: agent.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        content: 'Read fixture read-fixture.txt, then report its content.',
        clientMessageId: 'native-e2e-tool',
        selections: { model, permission },
      }),
    })
    const toolSession = await toolResponse.json()
    assert.equal(toolResponse.status, 200, JSON.stringify(toolSession))
    await until(
      async () =>
        JSON.stringify(
          (await runtime.hub.store.timeline(toolSession.session.id)).items,
        ).includes('NODE_TOOL_LINK_OK'),
      'real Harness tool execution',
      20000,
    )
    assert.equal(toolReadSeen, true)
    const toolTimeline = await runtime.hub.store.timeline(
      toolSession.session.id,
    )
    assert.ok(
      JSON.stringify(toolTimeline.items).includes('OWNED_WORKSPACE_READ_OK'),
    )
    const approvalPermission = permissions.catalog.permissions.find(
      (item) => item.metadata?.preset === 'workspace-write',
    )?.selectionId
    assert.ok(approvalPermission)
    const approvalResponse = await fetch(
      `${origin}/sessions/create-and-start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectorId: agent.connectorId,
          projectId: agent.projectId,
          runtime: 'dsh',
          runtimeId: 'dsh',
          content:
            'Exercise one approval request using a harmless output marker.',
          clientMessageId: 'native-e2e-approval',
          selections: { model, permission: approvalPermission },
        }),
      },
    )
    const approvalSession = await approvalResponse.json()
    assert.equal(approvalResponse.status, 200, JSON.stringify(approvalSession))
    let approvalNotice
    await until(
      async () => {
        const response = await fetch(
          `${origin}/sessions/${approvalSession.session.id}/runtime/notices`,
        )
        const value = await response.json()
        approvalNotice = value.notices?.find(
          (notice) =>
            notice.interactionType === 'approval' && notice.status === 'open',
        )
        return !!approvalNotice
      },
      'real Harness approval',
      20000,
    ).catch(async (error) => {
      t.diagnostic(
        JSON.stringify({
          approvalCalls,
          approvalToolResult,
          notices: await runtime.hub.call(
            agent.connectorId,
            'session.notices',
            {
              runtime: 'dsh',
              runtimeId: 'dsh',
              sessionId: approvalSession.session.id,
            },
          ),
        }),
      )
      throw error
    })
    assert.equal(approvalExecuted, false)
    const decisionUrl = `${origin}/sessions/${approvalSession.session.id}/runtime/notices/${approvalNotice.noticeId}/respond`
    const approvalDecision = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'allow-once' }),
    }
    const deniedOwner = await fetch(decisionUrl, {
      ...approvalDecision,
      headers: { ...approvalDecision.headers, 'X-Test-User': 'bob' },
    })
    assert.equal(deniedOwner.status, 404)
    const decision = await fetch(decisionUrl, approvalDecision)
    assert.equal((await decision.json()).ok, true)
    await until(
      async () =>
        JSON.stringify(
          (await runtime.hub.store.timeline(approvalSession.session.id)).items,
        ).includes('NODE_APPROVAL_LINK_OK'),
      'approved tool completion',
      15000,
    )
    assert.equal(approvalExecuted, true)
    const repeatedDecision = await fetch(decisionUrl, approvalDecision)
    assert.equal((await repeatedDecision.json()).ok, false)
    const cancelResponse = await fetch(`${origin}/sessions/create-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectorId: agent.connectorId,
        projectId: agent.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        content: 'Wait for cancellation test.',
        clientMessageId: 'native-e2e-cancel',
        selections: { model, permission },
      }),
    })
    const cancelSession = await cancelResponse.json()
    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelSession))
    await until(() => cancelPending, 'provider starts pending inference')
    const interrupted = await fetch(
      `${origin}/sessions/${cancelSession.session.id}/runtime/interrupt`,
      { method: 'POST', body: '{}' },
    )
    assert.equal(interrupted.status, 200)
    await until(
      () => cancelClosed,
      'cancel propagates to model provider',
      10000,
    )
    const [binding] = await runtime.db.query(
      'SELECT * FROM server_agents WHERE owner_user_id=$1',
      ['alice'],
    )
    const paths = runtime.service.manager.status('alice')
    assert.equal(paths.phase, 'ready')
    assert.equal(binding.runtime_id, 'dsh')
    const repeated = await runtime.service.prepare('alice')
    assert.equal(repeated.connectorId, agent.connectorId)
    await runtime.service.close()
    assert.equal(runtime.hub.isOnline(agent.connectorId), false)
    assert.equal(runtime.service.manager.status('alice').phase, 'stopped')
    // The real Host endpoint is generated in the temporary owned Home only.
    const home = join(
      runtime.rootDirectory,
      (await import('node:crypto'))
        .createHash('sha256')
        .update('alice')
        .digest('hex'),
      'home',
    )
    const endpoint = JSON.parse(
      await readFile(
        join(home, 'agents-anywhere', 'bridge', 'endpoint.json'),
        'utf8',
      ).catch(() => '{}'),
    )
    assert.equal(
      endpoint.pid,
      undefined,
      'clean Host shutdown removes its Bridge endpoint',
    )
  },
)
