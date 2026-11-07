import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { callMcp, discoverMcp, withMcp } from '../extensions/mcp.ts'

async function fixture(t) {
  const received = [],
    pending = new Map()
  let changed = false,
    closed = 0,
    onCall = () => {}
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      closed++
      response.writeHead(200)
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(405)
      response.end()
      return
    }
    let raw = ''
    for await (const part of request) raw += part
    const message = JSON.parse(raw)
    received.push({ message, token: request.headers.authorization })
    const send = (result) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'isolated-session',
      })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    if (message.method === 'initialize')
      return send({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'isolated-mcp', version: '1.0.0' },
      })
    if (message.method === 'tools/list')
      return send({
        tools: [
          {
            name: 'company_action',
            description: '真实 HTTP MCP 测试',
            inputSchema: {
              type: 'object',
              required: changed ? ['changedField'] : ['topic'],
              properties: changed
                ? { changedField: { type: 'string' } }
                : { topic: { type: 'string' } },
              additionalProperties: false,
            },
          },
        ],
      })
    if (message.method === 'tools/call') {
      if (message.params.arguments.topic === 'wait') {
        pending.set(message.id, response)
        onCall()
        return
      }
      return send({
        content: [{ type: 'text', text: message.params.arguments.topic }],
      })
    }
    if (message.method === 'notifications/cancelled') {
      const waiting = pending.get(message.params.requestId)
      waiting?.destroy()
      pending.delete(message.params.requestId)
    }
    response.writeHead(202)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  t.after(async () => {
    for (const response of pending.values()) response.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return {
    connection: {
      kind: 'http',
      endpoint: origin + '/mcp',
      token: 'fixture-secret',
      allowedOrigins: origin,
    },
    received,
    change: () => (changed = true),
    closed: () => closed,
    called: () =>
      new Promise((resolve) => {
        onCall = resolve
      }),
  }
}

test('Streamable HTTP discovery and invocation use the selected schema and authenticated connection', async (t) => {
  const remote = await fixture(t)
  const signal = AbortSignal.timeout(10000)
  const tools = await withMcp(remote.connection, signal, (client) =>
    discoverMcp(client, signal),
  )
  assert.equal(tools[0].mode, 'action')
  assert.equal(tools[0].id, 'company_action')
  const result = await callMcp(
    remote.connection,
    tools[0],
    { topic: '已完成实际 MCP 调用' },
    signal,
  )
  assert.equal(result.content[0].text, '已完成实际 MCP 调用')
  assert.ok(
    remote.received.every(
      (request) => request.token === 'Bearer fixture-secret',
    ),
  )
  assert.equal(remote.closed(), 2)
})

test('MCP schema changes require fresh administrator approval and never execute the old call', async (t) => {
  const remote = await fixture(t)
  const signal = AbortSignal.timeout(10000)
  const [tool] = await withMcp(remote.connection, signal, (client) =>
    discoverMcp(client, signal),
  )
  remote.change()
  await assert.rejects(
    () => callMcp(remote.connection, tool, { topic: '不可调用' }, signal),
    (error) => error.status === 409,
  )
  assert.equal(
    remote.received.filter((item) => item.message.method === 'tools/call')
      .length,
    0,
  )
})

test('MCP transport blocks unapproved private endpoints without sending credentials', async (t) => {
  const remote = await fixture(t)
  const signal = AbortSignal.timeout(10000)
  await assert.rejects(
    () =>
      withMcp({ ...remote.connection, allowedOrigins: '' }, signal, (client) =>
        discoverMcp(client, signal),
      ),
    (error) => error.status === 422,
  )
  assert.equal(remote.received.length, 0)
})

test('MCP cancellation reaches the remote tool and closes the session', async (t) => {
  const remote = await fixture(t)
  const controller = new AbortController()
  const [tool] = await withMcp(remote.connection, controller.signal, (client) =>
    discoverMcp(client, controller.signal),
  )
  const called = remote.called()
  const operation = callMcp(
    remote.connection,
    tool,
    { topic: 'wait' },
    controller.signal,
  )
  await called
  controller.abort()
  await assert.rejects(
    () => operation,
    (error) => error.status === 499,
  )
  assert.ok(
    remote.received.some(
      (item) => item.message.method === 'notifications/cancelled',
    ),
  )
  assert.equal(remote.closed(), 2)
})
