import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApplication } from '../application.ts'

test('Node composition registers every legacy HTTP and WebSocket endpoint exactly once', async () => {
  const database = {
    async query() {
      return []
    },
    async transaction(operation) {
      return operation(this)
    },
    async lease() {
      return null
    },
    async close() {},
  }
  const configuration = {
    secret: 'synthetic-contract-secret',
    encryptionKey: Buffer.alloc(32, 1).toString('base64url'),
    filesDirectory: 'unused-coverage-files',
    dataDirectory: 'unused-coverage-home',
    origins: [],
    databaseUrl: 'postgres://contract/contract',
  }
  const application = createApplication({
    configuration,
    database,
    redis: {
      async take() {
        return true
      },
    },
  })
  try {
    const key = (route) =>
      `${route.method} ${route.path.replace(/\{[^}]+\}/g, '{}')}`
    const routes = [
      ...application.router.routes,
      ...application.websocketPaths.map((path) => ({
        method: 'WEBSOCKET',
        path,
      })),
    ]
    const actual = new Set(routes.map(key))
    assert.equal(
      actual.size,
      routes.length,
      'duplicate route shape is not allowed',
    )
    const legacy = JSON.parse(
      await readFile(
        new URL('../contracts/legacy-routes.json', import.meta.url),
        'utf8',
      ),
    )
    assert.equal(
      legacy.length,
      193,
      'explicit baseline count prevents empty fixture checks',
    )
    const missing = legacy.filter((route) => !actual.has(key(route)))
    assert.deepEqual(
      missing,
      [],
      'a ported backend must not silently drop existing API routes',
    )
  } finally {
    await application.service.close()
  }
})
