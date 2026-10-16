import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { createPlatformServer } from '../http/platform-server.ts'

const respond = (text) => (_request, response) => response.end(text)
const origin = (address) => `http://127.0.0.1:${address.port}`

test('one native listener owns API and web traffic without a Python proxy', async (t) => {
  const calls = []
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
    services: [
      {
        name: 'test-service',
        async start() {
          calls.push('start')
        },
        async close() {
          calls.push('close')
        },
      },
    ],
  })
  t.after(() => platform.close())
  const [address, duplicate] = await Promise.all([
    platform.start(),
    platform.start(),
  ])
  assert.equal(address, duplicate)
  for (const [path, expected] of [
    ['/api/v2', 'api'],
    ['/api/v2/auth/me?next=/', 'api'],
    ['/api/v20/auth/me', 'web'],
    ['/', 'web'],
  ]) {
    const response = await fetch(`${origin(address)}${path}`)
    assert.equal(await response.text(), expected)
  }
  await Promise.all([platform.close(), platform.close()])
  assert.deepEqual(calls, ['start', 'close'])
  await assert.rejects(platform.start(), /closed/)
})

test('startup failure rolls back partially initialized services in reverse order', async () => {
  const calls = []
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
    services: ['database', 'broker', 'web'].map((name) => ({
      name,
      async start() {
        calls.push(`start:${name}`)
        if (name === 'broker') throw new Error('broker unavailable')
      },
      async close() {
        calls.push(`close:${name}`)
      },
    })),
  })
  await assert.rejects(platform.start(), /broker unavailable/)
  await platform.close()
  assert.deepEqual(calls, [
    'start:database',
    'start:broker',
    'close:broker',
    'close:database',
  ])
})

test('close during preparation does not leave a listening platform', async () => {
  const started = Promise.withResolvers()
  const prepared = Promise.withResolvers()
  const calls = []
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
    services: [
      {
        name: 'web',
        async start() {
          started.resolve()
          await prepared.promise
        },
        async close() {
          calls.push('closed')
        },
      },
    ],
  })
  const starting = assert.rejects(platform.start(), /cancelled/)
  await started.promise
  const closing = platform.close()
  prepared.resolve()
  await Promise.all([starting, closing])
  assert.deepEqual(calls, ['closed'])
})

test('failed HTTP handler returns a safe error and the next request still works', async (t) => {
  const reported = []
  const platform = createPlatformServer({
    port: 0,
    api() {
      throw new Error('synthetic-secret-do-not-return')
    },
    web: respond('still alive'),
    onError: (error) => reported.push(error),
  })
  t.after(() => platform.close())
  const address = await platform.start()
  const failure = await fetch(`${origin(address)}/api/v2/auth/me`)
  assert.equal(failure.status, 500)
  assert.deepEqual(await failure.json(), { detail: 'internal server error' })
  assert.equal(reported.length, 1)
  assert.equal(await (await fetch(origin(address))).text(), 'still alive')
})

test('client disconnect aborts the upstream operation without waiting for shutdown', async (t) => {
  const aborted = Promise.withResolvers()
  const platform = createPlatformServer({
    port: 0,
    api(_request, response, { signal }) {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      response.write('first-event\n')
    },
    web: respond('web'),
  })
  t.after(() => platform.close())
  const address = await platform.start()
  const request = httpRequest(`${origin(address)}/api/v2/sessions/stream`)
  request.on('error', () => {})
  request.end()
  const [response] = await once(request, 'response')
  await once(response, 'data')
  response.destroy()
  await aborted.promise
})

async function upgrade(address, path) {
  const socket = createConnection({ host: '127.0.0.1', port: address.port })
  await once(socket, 'connect')
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  )
  const [data] = await once(socket, 'data')
  socket.destroy()
  return data.toString()
}

test('API upgrades and Next HMR upgrades have independent handlers', async (t) => {
  const routes = []
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
    apiUpgrade(request, socket) {
      routes.push(['api', request.url])
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    },
    webUpgrade(request, socket) {
      routes.push(['web', request.url])
      socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
    },
  })
  t.after(() => platform.close())
  const address = await platform.start()
  assert.match(await upgrade(address, '/api/v2/connector/ws'), /401/)
  assert.match(await upgrade(address, '/_next/webpack-hmr'), /204/)
  assert.deepEqual(routes, [
    ['api', '/api/v2/connector/ws'],
    ['web', '/_next/webpack-hmr'],
  ])
})

test('unregistered upgrades are rejected instead of entering a web page handler', async (t) => {
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
  })
  t.after(() => platform.close())
  assert.match(
    await upgrade(await platform.start(), '/api/v2/connector/ws'),
    /404/,
  )
})

test('busy-port failure cleans up initialized services', async (t) => {
  const first = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
  })
  t.after(() => first.close())
  const address = await first.start()
  const calls = []
  const second = createPlatformServer({
    port: address.port,
    api: respond('api'),
    web: respond('web'),
    services: [
      {
        name: 'database',
        async start() {
          calls.push('started')
        },
        async close() {
          calls.push('closed')
        },
      },
    ],
  })
  await assert.rejects(second.start(), { code: 'EADDRINUSE' })
  await second.close()
  assert.deepEqual(calls, ['started', 'closed'])
})

test(
  'shutdown closes upgraded sockets as well as HTTP connections',
  { timeout: 1500 },
  async (t) => {
    const platform = createPlatformServer({
      port: 0,
      shutdownTimeoutMs: 30,
      api: respond('api'),
      web: respond('web'),
      apiUpgrade(_request, socket) {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      },
    })
    const address = await platform.start()
    const socket = createConnection({ host: '127.0.0.1', port: address.port })
    t.after(async () => {
      socket.destroy()
      await platform.close()
    })
    await once(socket, 'connect')
    socket.write(
      'GET /api/v2/connector/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    )
    const [data] = await once(socket, 'data')
    assert.match(data.toString(), /101 Switching Protocols/)
    const closed = once(socket, 'close')
    await platform.close()
    await closed
    assert.equal(socket.destroyed, true)
  },
)

test('one service cleanup failure does not skip cleanup of other services', async () => {
  const calls = []
  const platform = createPlatformServer({
    port: 0,
    api: respond('api'),
    web: respond('web'),
    services: ['database', 'runtime'].map((name) => ({
      name,
      async start() {},
      async close() {
        calls.push(name)
        if (name === 'runtime') throw new Error('runtime cleanup failed')
      },
    })),
  })
  await platform.start()
  await assert.rejects(platform.close(), AggregateError)
  assert.deepEqual(calls, ['runtime', 'database'])
})

test('shutdown aborts streaming operations and releases their sockets', async () => {
  const aborted = Promise.withResolvers()
  const platform = createPlatformServer({
    port: 0,
    shutdownTimeoutMs: 50,
    api(_request, response, { signal }) {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      response.write('event\n')
    },
    web: respond('web'),
  })
  const address = await platform.start()
  const request = httpRequest(`${origin(address)}/api/v2/sessions/stream`)
  request.on('error', () => {})
  request.end()
  const [response] = await once(request, 'response')
  response.on('error', () => {})
  await once(response, 'data')
  const closed = new Promise((resolve) => response.once('close', resolve))
  await platform.close()
  await aborted.promise
  await closed
  assert.equal(response.destroyed, true)
})
