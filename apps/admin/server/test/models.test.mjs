import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { ApiRouter } from '../http/api-router.ts'
import { createPlatformServer } from '../http/platform-server.ts'
import { ModelService, validateProvider } from '../models/model-service.ts'
import { ModelProxy, registerModelRoutes } from '../models/model-routes.ts'
import {
  publicAddress,
  providerRequest,
  resolveProviderAddress,
} from '../models/provider-http.ts'
import { ModelGateway } from '../runtime/model-gateway.ts'
import { withTestDatabase } from './support/database.mjs'

const provider = (overrides = {}) => ({
  name: 'Synthetic model',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'synthetic-private-key',
  models: [{ modelId: 'test-model', name: 'Test model' }],
  ...overrides,
})
async function listening(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('model validation preserves write-only keys and rejects malformed protocol or ambiguous configuration', () => {
  assert.equal(validateProvider(provider()).models[0].contextWindow, null)
  for (const value of [
    provider({ protocol: 'other' }),
    provider({ baseUrl: 'http://key:secret@provider.example' }),
    provider({ clearApiKey: true }),
    provider({ enabled: 'yes' }),
    provider({
      models: [
        { modelId: 'same', name: 'one' },
        { modelId: 'same', name: 'two' },
      ],
    }),
    provider({ models: [{ modelId: 'id', name: 'name', maxTokens: -1 }] }),
  ])
    assert.throws(() => validateProvider(value))
})
test('personal providers reject mixed private/public DNS and pin explicit allowlisted origins', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '100.64.1.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(ip), false, ip)
  assert.equal(publicAddress('8.8.8.8'), true)
  await assert.rejects(
    resolveProviderAddress('https://model.example/v1', '', async () => [
      '8.8.8.8',
      '127.0.0.1',
    ]),
    /only to public/,
  )
  await assert.rejects(
    resolveProviderAddress(
      'https://model.example/v1',
      'https://model.example/path',
      async () => ['8.8.8.8'],
    ),
    /allowlist/,
  )
  const pin = await resolveProviderAddress(
    'http://model.example:1234/v1',
    'http://model.example:1234',
    async () => ['127.0.0.1'],
  )
  assert.equal(pin.address, '127.0.0.1')
  await assert.rejects(
    resolveProviderAddress(
      'http://model.example:1235/v1',
      'http://model.example:1234',
      async () => ['127.0.0.1'],
    ),
    /only to public/,
  )
})
test('model HTTP uses the validated DNS result once, retains Host and never follows redirects', async (t) => {
  let host
  const upstream = await listening(t, (request, response) => {
    host = request.headers.host
    response.writeHead(302, { location: 'http://127.0.0.1:1/secret' })
    response.end()
  })
  const port = new URL(upstream).port
  let resolutions = 0
  const response = await providerRequest({
    url: `http://provider.invalid:${port}/v1/models`,
    method: 'GET',
    headers: {},
    personal: true,
    allowedOrigins: `http://provider.invalid:${port}`,
    resolver: async () => {
      resolutions++
      return ['127.0.0.1']
    },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.statusCode, 302)
  response.destroy()
  assert.equal(host, `provider.invalid:${port}`)
  assert.equal(resolutions, 1)
})

test('real PostgreSQL provider ownership, encrypted persistence and transactional defaults', async (t) => {
  const db = await withTestDatabase(t)
  const audits = []
  const models = new ModelService({
    db,
    encryptionKey: randomBytes(32).toString('base64url'),
    audit: async (...entry) => audits.push(entry),
  })
  const alice = await models.save(provider(), 'alice', 'alice')
  assert.equal(alice.source, 'personal')
  assert.equal(alice.apiKeyConfigured, true)
  assert.equal(JSON.stringify(alice).includes('synthetic-private-key'), false)
  const raw = (
    await db.query(
      'SELECT key_ciphertext FROM platform_model_providers WHERE id=$1',
      [alice.providerId],
    )
  )[0]
  assert.notEqual(raw.key_ciphertext, 'synthetic-private-key')
  assert.equal(
    (
      await models.resolve(
        'alice',
        alice.providerId,
        alice.protocol,
        'test-model',
      )
    ).key,
    'synthetic-private-key',
  )
  await assert.rejects(
    models.resolve('bob', alice.providerId, alice.protocol, 'test-model'),
    /unavailable/,
  )
  await assert.rejects(
    models.save(provider(), 'admin', null, alice.providerId),
    /not found/,
  )
  await assert.rejects(
    models.remove(alice.providerId, 'bob', 'bob'),
    /not found/,
  )
  await models.save(
    provider({ apiKey: undefined }),
    'alice',
    'alice',
    alice.providerId,
  )
  assert.equal(
    (
      await models.resolve(
        'alice',
        alice.providerId,
        alice.protocol,
        'test-model',
      )
    ).key,
    'synthetic-private-key',
  )
  await models.setDefault(
    { providerId: alice.providerId, modelId: 'test-model' },
    'alice',
    'alice',
  )
  await assert.rejects(
    models.save(
      provider({ enabled: false }),
      'alice',
      'alice',
      alice.providerId,
    ),
    /default selection/,
  )
  const platform = await models.save(provider({ name: 'Global' }), 'admin')
  await models.setDefault(
    { providerId: platform.providerId, modelId: 'test-model' },
    'admin',
  )
  const catalog = await models.catalog('alice')
  assert.equal(catalog.default.providerId, alice.providerId)
  assert.equal(catalog.platformDefault.providerId, platform.providerId)
  assert.equal(
    catalog.scope,
    createHash('sha256').update('user:alice').digest('hex'),
  )
  assert.equal(JSON.stringify(catalog).includes('baseUrl'), false)
  await models.remove(alice.providerId, 'alice', 'alice')
  assert.equal(
    (await models.catalog('alice')).default.providerId,
    platform.providerId,
  )
  assert.equal(
    audits.some((entry) => entry[1] === 'models.default.save'),
    true,
  )
})

test('all three model protocols stream tools unchanged and loopback capability enforces identity', async (t) => {
  const db = await withTestDatabase(t)
  const records = []
  const upstream = await listening(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    records.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks)),
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"tool_calls":[{"id":"call-one"}]}\n\n')
    setTimeout(() => response.end('data: [DONE]\n\n'), 20)
  })
  const models = new ModelService({
    db,
    encryptionKey: randomBytes(32).toString('base64url'),
    audit: async () => {},
  })
  let admitted = true
  const account = {
    userId: 'alice',
    permissions: ['models.use', 'models.personal.manage'],
    disabled: false,
    deletedAt: null,
    resetRequired: false,
  }
  const proxy = new ModelProxy({
    models,
    allowedOrigins: upstream,
    auth: {
      getAccount: async () => account,
      connectorAllowed: async (id, owner, hash) =>
        admitted &&
        id === 'owned' &&
        owner === 'alice' &&
        (!hash || hash === 'fingerprint'),
      authenticateConnector: async (token) =>
        token === 'connector-token'
          ? { id: 'owned', userId: 'alice', tokenHash: 'fingerprint' }
          : null,
    },
  })
  const gateway = new ModelGateway({
    proxy,
    owner: 'alice',
    connector: 'owned',
    fingerprint: 'fingerprint',
  })
  const origin = await gateway.start()
  t.after(() => gateway.close())
  assert.equal((await fetch(`${origin}/catalog`)).status, 401)
  const catalogResponse = await fetch(`${origin}/catalog`, {
    headers: { Authorization: `Bearer ${gateway.secret}` },
  })
  const catalog = await catalogResponse.json()
  for (const [protocol, operation] of [
    ['openai-completions', 'chat/completions'],
    ['openai-responses', 'responses'],
    ['anthropic-messages', 'v1/messages'],
  ]) {
    const saved = await models.save(
      provider({ protocol, baseUrl: upstream }),
      'alice',
      'alice',
    )
    const headers =
      protocol === 'anthropic-messages'
        ? { 'x-api-key': gateway.secret, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${gateway.secret}` }
    const response = await fetch(
      `${origin}/scopes/${catalog.scope}/providers/${saved.providerId}/${protocol}/${operation}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          stream: true,
          tools: [{ name: 'hello' }],
        }),
      },
    )
    assert.equal(response.status, 200)
    assert.equal(
      await response.text(),
      'data: {"tool_calls":[{"id":"call-one"}]}\n\ndata: [DONE]\n\n',
    )
    assert.deepEqual(records.at(-1).body.tools, [{ name: 'hello' }])
    assert.equal(
      protocol === 'anthropic-messages'
        ? records.at(-1).headers['x-api-key']
        : records.at(-1).headers.authorization,
      protocol === 'anthropic-messages'
        ? 'synthetic-private-key'
        : 'Bearer synthetic-private-key',
    )
    assert.equal(JSON.stringify(records.at(-1)).includes(gateway.secret), false)
  }
  admitted = false
  assert.equal(
    (
      await fetch(`${origin}/catalog`, {
        headers: { Authorization: `Bearer ${gateway.secret}` },
      })
    ).status,
    403,
  )
})

test('API model routes reject foreign device and terminate waiting inference on credential revocation', async (t) => {
  const db = await withTestDatabase(t)
  let disconnectedResolve
  const disconnected = new Promise((resolve) => (disconnectedResolve = resolve))
  const upstream = await listening(t, (request, response) => {
    request.resume()
    response.on('close', disconnectedResolve)
  })
  const models = new ModelService({
    db,
    encryptionKey: randomBytes(32).toString('base64url'),
    audit: async () => {},
  })
  const saved = await models.save(
    provider({ baseUrl: upstream }),
    'alice',
    'alice',
  )
  let admitted = true
  const account = {
    userId: 'alice',
    permissions: ['models.use'],
    disabled: false,
    deletedAt: null,
    resetRequired: false,
  }
  const proxy = new ModelProxy({
    models,
    allowedOrigins: upstream,
    auth: {
      getAccount: async () => account,
      connectorAllowed: async (id) => admitted && id === 'owned',
      authenticateConnector: async () => null,
    },
  })
  const router = new ApiRouter(async () => account)
  registerModelRoutes(router, models, proxy)
  const server = createPlatformServer({
    api: router.handle,
    web: (_request, response) => response.end(),
    port: 0,
  })
  const address = await server.start()
  t.after(() => server.close())
  const url = `http://127.0.0.1:${address.port}/api/v2/models/${saved.providerId}/openai-completions/chat/completions`
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SuperDsh-Connector-Id': 'foreign',
    },
    body: JSON.stringify({ model: 'test-model', stream: true }),
  }
  assert.equal((await fetch(url, request)).status, 403)
  request.headers['X-SuperDsh-Connector-Id'] = 'owned'
  const waiting = fetch(url, request)
  setTimeout(() => {
    admitted = false
  }, 100)
  assert.ok((await waiting).status >= 400)
  await Promise.race([
    disconnected,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('inference did not cancel')),
        4000,
      ).unref(),
    ),
  ])
})
