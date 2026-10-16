import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import WebSocket from 'ws'
import { startNodePlatform } from '../main.ts'
import { withTestDatabase } from './support/database.mjs'

async function until(operation, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!(await operation())) {
    if (Date.now() > deadline) throw new Error(`${message} timed out`)
    await delay(75)
  }
}

async function processExists(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(
      'tasklist.exe',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
    )
    return stdout.includes(`"${pid}"`)
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  'full application login/logout keeps real Agent inference alive and wires owned files, PTY and cleanup',
  { timeout: 180000 },
  async (t) => {
    assert.ok(
      process.env.SUPERDSH_NODE_TEST_REDIS_URL,
      'isolated Redis is required',
    )
    let cleanupDatabase
    const db = await withTestDatabase({
      after: (callback) => {
        cleanupDatabase = callback
      },
    })
    const directory = await mkdtemp(
      join(tmpdir(), 'superdsh-runtime-app-中文-'),
    )
    let platform
    let upstream
    const sockets = []
    t.after(async () => {
      for (const socket of sockets) socket.terminate()
      try {
        await platform?.close()
      } finally {
        upstream?.closeAllConnections()
        if (upstream?.listening)
          await new Promise((resolve) => upstream.close(resolve))
        await cleanupDatabase()
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
        assert.ok(directory.includes('superdsh-runtime-app-中文-'))
        await rm(directory, { recursive: true, force: true })
      }
    })
    let pendingResponse
    let modelDisconnected = false
    upstream = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      assert.equal(
        request.headers.authorization,
        'Bearer synthetic-assembly-key',
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const actualTurn =
        body.tools?.some((tool) => tool.function?.name === 'read') &&
        body.messages?.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes('CONTINUE_AFTER_LOGOUT'),
        )
      const write = (content) =>
        response.write(
          `data: ${JSON.stringify({ id: 'assembly-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
        )
      if (actualTurn) {
        pendingResponse = response
        response.once('close', () => {
          modelDisconnected = true
        })
        write('before logout ')
      } else {
        write('Synthetic title')
        response.end('data: [DONE]\n\n')
      }
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    platform = await startNodePlatform(
      {
        databaseUrl: db.testUrl,
        redisUrl: process.env.SUPERDSH_NODE_TEST_REDIS_URL,
        secret: randomBytes(32).toString('hex'),
        encryptionKey: randomBytes(32).toString('base64url'),
        dataDirectory: directory,
        filesDirectory: join(directory, 'files'),
        hostname: '127.0.0.1',
        port: 0,
        apiPort: 0,
        origins: [],
        setupToken: 'synthetic-runtime-setup',
        dev: true,
      },
      { web: false, log: () => {} },
    )
    const origin = `http://127.0.0.1:${platform.address.port}`
    const request = async (path, token, body, extra = {}) => {
      const response = await fetch(`${origin}/api/v2${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        ...extra,
        headers: {
          'Content-Type': 'application/json',
          'X-SuperDsh-Agent-Preparation': 'deferred',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extra.headers,
        },
      })
      const text = await response.text()
      return { status: response.status, data: text ? JSON.parse(text) : null }
    }
    const registered = await request('/auth/register', null, {
      username: 'alice',
      password: 'synthetic-password',
      displayName: 'Alice',
      setupToken: 'synthetic-runtime-setup',
      clientType: 'native',
    })
    assert.equal(registered.status, 200, JSON.stringify(registered.data))
    const userId = registered.data.userId
    const adminToken = registered.data.accessToken
    const provider = await request('/admin/models/providers', adminToken, {
      name: 'Assembly test model',
      protocol: 'openai-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      apiKey: 'synthetic-assembly-key',
      models: [
        {
          modelId: 'synthetic-model',
          name: 'Synthetic',
          maxTokens: 1024,
          contextWindow: 32768,
        },
      ],
    })
    assert.equal(provider.status, 200, JSON.stringify(provider.data))
    assert.equal(
      (
        await request(
          '/admin/models/default',
          adminToken,
          { providerId: provider.data.providerId, modelId: 'synthetic-model' },
          { method: 'PUT' },
        )
      ).status,
      200,
    )
    assert.equal((await db.query('SELECT * FROM server_agents')).length, 0)
    const loginA = await request(
      '/auth/login',
      null,
      {
        identifier: 'alice',
        password: 'synthetic-password',
        clientType: 'native',
        clientName: 'Synthetic Android',
      },
      { headers: { 'X-SuperDsh-Agent-Preparation': '' } },
    )
    assert.equal(loginA.status, 200)
    const loginB = await request('/auth/login', null, {
      identifier: 'alice',
      password: 'synthetic-password',
      clientType: 'native',
      clientName: 'Synthetic Desktop',
    })
    assert.equal(loginB.status, 200)
    const tokenA = loginA.data.accessToken
    const tokenB = loginB.data.accessToken
    let agent
    await until(
      async () => {
        const result = await request('/server-agent', tokenB)
        assert.equal(result.status, 200)
        agent = result.data.agent
        if (agent.status === 'error') throw new Error(agent.error)
        return agent.status === 'running'
      },
      'real Host automatically prepared by native login',
      125000,
    )
    const workspace = (
      await db.query('SELECT workspace_path FROM projects WHERE id=$1', [
        agent.projectId,
      ])
    )[0].workspace_path
    const fsBase = `/connectors/${agent.connectorId}/fs`
    assert.equal(
      (
        await request(`${fsBase}/write`, tokenA, {
          root: workspace,
          path: 'assembly.txt',
          content: 'OWNED_ASSEMBLY_FILE',
        })
      ).status,
      200,
    )
    const read = await request(`${fsBase}/readText`, tokenB, {
      root: workspace,
      path: 'assembly.txt',
    })
    assert.equal(read.status, 200, JSON.stringify(read.data))
    assert.equal(read.data.content, 'OWNED_ASSEMBLY_FILE')
    assert.equal(
      (
        await request(`${fsBase}/readText`, tokenB, {
          root: workspace,
          path: '../outside',
        })
      ).status,
      403,
    )
    const terminalBase = `/connectors/${agent.connectorId}/terminals-v2`
    const createdTerminal = await request(terminalBase, tokenA, {
      root: workspace,
      cwd: '.',
      cols: 80,
      rows: 24,
    })
    assert.equal(
      createdTerminal.status,
      200,
      JSON.stringify(createdTerminal.data),
    )
    const terminal =
      createdTerminal.data.result.terminal ?? createdTerminal.data.result
    assert.ok(terminal.pid > 0, JSON.stringify(createdTerminal.data))
    const terminalUrl = `${origin.replace('http:', 'ws:')}/api/v2${terminalBase}/${terminal.terminalId}/stream`
    const socketA = new WebSocket(terminalUrl, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    const socketB = new WebSocket(terminalUrl, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    sockets.push(socketA, socketB)
    let terminalOutput = ''
    socketB.on('message', (bytes) => {
      const value = JSON.parse(bytes)
      if (typeof value.data === 'string')
        terminalOutput += Buffer.from(value.data, 'base64').toString('utf8')
    })
    await Promise.all([once(socketA, 'open'), once(socketB, 'open')])
    const catalog = await request('/models/catalog', tokenB)
    const model = `dsh:model:${Buffer.from(JSON.stringify([`superdsh-${catalog.data.scope}-${provider.data.providerId}`, 'synthetic-model', null])).toString('base64url')}`
    const permissions = await request(
      `/connectors/${agent.connectorId}/runtimes/dsh/catalogs/permission`,
      tokenB,
    )
    assert.equal(permissions.status, 200, JSON.stringify(permissions.data))
    const permission = permissions.data.catalog.permissions.find(
      (item) => item.enabled !== false,
    ).selectionId
    const created = await request('/sessions/create-and-start', tokenA, {
      connectorId: agent.connectorId,
      projectId: agent.projectId,
      runtime: 'dsh',
      runtimeId: 'dsh',
      content: 'CONTINUE_AFTER_LOGOUT',
      clientMessageId: 'assembly-one-turn',
      selections: { model, permission },
    })
    assert.equal(created.status, 200, JSON.stringify(created.data))
    await until(() => !!pendingResponse, 'stream reaches real Host gateway')
    const sessionId = created.data.session.id
    const logout = await request('/auth/logout', tokenA, {
      refreshToken: loginA.data.refreshToken,
    })
    assert.equal(logout.status, 204)
    await until(
      () => socketA.readyState === WebSocket.CLOSED,
      'revoked login terminal websocket closes',
    )
    assert.equal((await request('/auth/me', tokenA)).status, 401)
    assert.equal((await request('/auth/me', tokenB)).status, 200)
    await delay(1200)
    assert.equal(
      modelDisconnected,
      false,
      'client logout must not abort internal Connector inference',
    )
    assert.equal(platform.app.agents.manager.status(userId).phase, 'ready')
    assert.equal(socketB.readyState, WebSocket.OPEN)
    const command =
      process.platform === 'win32'
        ? "Write-Output ('PTY_' + 'ASSEMBLY_OK')\r"
        : "printf 'PTY_%s\\n' ASSEMBLY_OK\r"
    socketB.send(
      JSON.stringify({
        type: 'input',
        data: Buffer.from(command).toString('base64'),
      }),
    )
    await until(
      () => terminalOutput.includes('PTY_ASSEMBLY_OK'),
      'live native PTY survives other client logout',
    )
    pendingResponse.write(
      `data: ${JSON.stringify({ id: 'assembly-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'AFTER_LOGOUT_LINK_OK' }, finish_reason: null }] })}\n\n`,
    )
    pendingResponse.write(
      'data: {"id":"assembly-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    pendingResponse.end('data: [DONE]\n\n')
    await until(async () => {
      const snapshot = await request(`/sessions/${sessionId}/snapshot`, tokenB)
      assert.equal(snapshot.status, 200)
      return JSON.stringify(snapshot.data).includes('AFTER_LOGOUT_LINK_OK')
    }, 'second login observes completed Agent result')
    assert.equal((await db.query('SELECT * FROM server_agents')).length, 1)
    const stop = platform.close()
    await stop
    assert.equal(platform.app.agents.manager.status(userId).phase, 'stopped')
    await until(
      () => !platform.app.hub.isOnline(agent.connectorId),
      'connector cleaned up',
    )
    await until(
      async () => !(await processExists(terminal.pid)),
      'native terminal process cleanup',
    )
    await assert.rejects(
      stat(
        join(dirname(workspace), 'home/agents-anywhere/bridge/endpoint.json'),
      ),
      { code: 'ENOENT' },
    )
  },
)
