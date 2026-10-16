import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { startNodePlatform } from '../main.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t, options = {}) {
  let cleanupDatabase
  const db = await withTestDatabase({
    after: (fn) => {
      cleanupDatabase = fn
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-node-app-中文-'))
  const config = {
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
    setupToken: 'synthetic-setup-token',
    dev: true,
  }
  let platform
  t.after(async () => {
    try {
      await platform?.close()
    } finally {
      await cleanupDatabase()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(directory.includes('superdsh-node-app-中文-'))
      await rm(directory, { recursive: true, force: true })
    }
  })
  platform = await startNodePlatform(config, {
    web: false,
    log: () => {},
    ...options,
  })
  const base = `http://127.0.0.1:${platform.address.port}/api/v2`
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-SuperDsh-Agent-Preparation': 'deferred',
        ...options.headers,
      },
    })
    const data = response.status === 204 ? null : await response.json()
    return { response, data }
  }
  return { db, config, platform, request }
}

const integration =
  process.env.SUPERDSH_NODE_TEST_DATABASE_URL &&
  process.env.SUPERDSH_NODE_TEST_REDIS_URL
    ? {}
    : { skip: 'disposable PostgreSQL and Redis runner required' }

test(
  'composed Node platform logs in browser/native clients, rotates credentials and defers Agent preparation',
  integration,
  async (t) => {
    const { db, platform, request } = await fixture(t)
    assert.equal((await request('/health/ready')).response.status, 200)
    const created = await request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'alice',
        displayName: 'Alice',
        password: 'synthetic-password',
        setupToken: 'synthetic-setup-token',
      }),
    })
    assert.equal(created.response.status, 200, JSON.stringify(created.data))
    assert.equal(created.data.role, 'admin')
    assert.ok(created.response.headers.get('set-cookie').includes('HttpOnly'))
    assert.equal(created.data.refreshToken, null)
    const browser = created.data.accessToken
    const native = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'alice',
        password: 'synthetic-password',
        clientType: 'native',
        clientName: 'Synthetic Android',
      }),
    })
    assert.equal(native.response.status, 200)
    assert.ok(native.data.refreshToken)
    const auth = { Authorization: `Bearer ${browser}` }
    const navigation = await request('/navigation', { headers: auth })
    assert.equal(
      navigation.response.status,
      200,
      JSON.stringify(navigation.data),
    )
    assert.ok(JSON.stringify(navigation.data).includes('access.users'))
    assert.equal(
      (await db.query('SELECT * FROM server_agents')).length,
      0,
      'web login and management do not prepare an Agent',
    )
    const refresh = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: native.data.refreshToken }),
    })
    assert.equal(refresh.response.status, 200)
    assert.notEqual(refresh.data.refreshToken, native.data.refreshToken)
    await request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refresh.data.refreshToken }),
    })
    assert.equal(
      (
        await request('/auth/me', {
          headers: { Authorization: `Bearer ${refresh.data.accessToken}` },
        })
      ).response.status,
      401,
    )
    assert.equal(
      (await request('/auth/me', { headers: auth })).response.status,
      200,
      'logout on Android leaves browser login valid',
    )
    assert.equal(
      platform.app.agents.manager.status(created.data.userId).phase,
      'idle',
    )
  },
)

test(
  'composed startup rejects a second platform owner without altering the active login',
  integration,
  async (t) => {
    const { config, request } = await fixture(t)
    await assert.rejects(
      startNodePlatform({ ...config }, { web: false, log: () => {} }),
      /already owns/,
    )
    assert.equal((await request('/health/ready')).response.status, 200)
  },
)
