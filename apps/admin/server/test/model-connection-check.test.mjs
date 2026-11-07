import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { checkModelConnection } from '../models/connection-check.ts'

async function fixture(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    adapter: 'volcengine-ark',
    baseUrl: origin + '/api/plan/v3',
    key: 'synthetic-private-key',
    allowedOrigins: origin,
    signal: AbortSignal.timeout(5000),
  }
}

for (const status of [404, 405]) {
  test(`a model-list ${status} is inconclusive, never an invalid-key verdict or a paid fallback`, async (t) => {
    let calls = 0
    const options = await fixture(t, (req, res) => {
      calls++
      assert.equal(req.method, 'GET')
      assert.equal(req.url, '/api/plan/v3/models')
      assert.equal(req.headers.authorization, 'Bearer synthetic-private-key')
      res.writeHead(status)
      res.end()
    })
    const result = await checkModelConnection(options)
    assert.equal(result.ok, false)
    assert.equal(result.verification, 'requires-trial')
    assert.match(result.note, /不代表 Key 无效/)
    assert.equal(calls, 1)
  })
}

test('Ark authentication failure explains endpoint scope without leaking upstream bodies', async (t) => {
  const options = await fixture(t, (_req, res) => {
    res.writeHead(401)
    res.end(JSON.stringify({ error: { message: 'synthetic-private-key' } }))
  })
  await assert.rejects(checkModelConnection(options), (error) => {
    assert.equal(error.code, 'provider_authentication_failed')
    assert.match(error.message, /401/)
    assert.match(error.message, /Agent Plan/)
    assert.doesNotMatch(error.message, /synthetic-private-key/)
    return true
  })
})

test('access-denied responses are distinct from authentication failure', async (t) => {
  const options = await fixture(t, (_req, res) => {
    res.writeHead(403)
    res.end()
  })
  await assert.rejects(
    checkModelConnection(options),
    (error) => error.code === 'provider_access_denied',
  )
})

test('Anthropic probes use native key/version headers and do not claim inference was tested', async (t) => {
  const options = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers['x-api-key'], 'synthetic-private-key')
    assert.equal(req.headers['anthropic-version'], '2023-06-01')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"data":[]}')
  })
  const result = await checkModelConnection({
    ...options,
    adapter: 'anthropic-messages',
  })
  assert.equal(result.verification, 'model-list')
  assert.match(result.note, /仍需试运行/)
})

test('a non-public DNS result stays blocked and reports a scoped configuration remedy', async () => {
  await assert.rejects(
    checkModelConnection({
      adapter: 'volcengine-ark',
      baseUrl: 'http://127.0.0.1:9',
      key: 'synthetic',
      allowedOrigins: '',
      signal: AbortSignal.timeout(1000),
    }),
    (error) => {
      assert.equal(error.code, 'provider_address_blocked')
      assert.match(error.message, /Fake-IP/)
      assert.match(error.message, /不要关闭地址校验/)
      return true
    },
  )
})
