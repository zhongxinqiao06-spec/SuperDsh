import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { HarnessBridgeClient } from '../runtime/bridge-client.ts'
import { BridgeSync, checkpoint } from '../runtime/bridge-sync.ts'

async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'superdsh-node-bridge-中文-'))
  t.after(async () => {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(home.includes('superdsh-node-bridge-中文-'))
    await rm(home, { recursive: true, force: true })
  })
  return home
}
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out')
    await delay(10)
  }
}

test('native bridge authenticates the owned loopback TCP endpoint and cancels exact pending request', async (t) => {
  const home = await temporary(t)
  const requests = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk
      let split
      while ((split = input.indexOf('\n')) >= 0) {
        const value = JSON.parse(input.slice(0, split))
        input = input.slice(split + 1)
        requests.push(value)
        if (value.method === 'initialize') {
          assert.equal(value.params.authToken, 'test-bridge-secret')
          assert.equal(value.params.sessionNamespace, 'owned-connector')
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'early',
              params: { ready: true },
            }) + '\n',
          )
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: value.id,
              result: { identity: { runtime: 'dsh', protocolVersion: '1.0' } },
            }) + '\n',
          )
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const directory = join(home, 'agents-anywhere', 'bridge')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({
      version: 1,
      host: '127.0.0.1',
      port: server.address().port,
      token: 'test-bridge-secret',
      pid: process.pid,
    }),
  )
  const notifications = []
  const bridge = new HarnessBridgeClient({
    notification: (event) => notifications.push(event),
    disconnected: () => {},
  })
  t.after(() => bridge.close())
  await bridge.start(home, 'owned-connector', AbortSignal.timeout(5000))
  assert.deepEqual(notifications, [
    { method: 'early', params: { ready: true } },
  ])
  const controller = new AbortController()
  const waiting = bridge.request('wait', {}, controller.signal)
  await until(() => requests.some((item) => item.method === 'wait'))
  controller.abort()
  await assert.rejects(waiting, /cancelled/)
  await until(() => requests.some((item) => item.method === '$/cancelRequest'))
  assert.equal(
    requests.find((item) => item.method === '$/cancelRequest').params.id,
    requests.find((item) => item.method === 'wait').id,
  )
})

test('projection sync commits full snapshot before checkpoint save and transport ACK', async (t) => {
  const directory = await temporary(t)
  const calls = [],
    ingested = []
  let healthy = false
  const client = {
    request: async (method, params) => {
      calls.push([method, params])
      return method === 'runtime.sync.subscribe'
        ? { streamId: 'stream-one', projectionVersion: 2, checkpointVersion: 1 }
        : {}
    },
  }
  const sync = new BridgeSync({
    client,
    directory,
    ingest: async (events) => {
      ingested.push(...events)
    },
    healthy: async () => {
      healthy = true
    },
    failed: () => assert.fail('sync should remain healthy'),
  })
  t.after(() => sync.stop())
  await sync.start()
  const cp = {
    version: 1,
    projectionVersion: 2,
    throughSeq: 12,
    historyHash: 'f'.repeat(64),
    settled: true,
  }
  sync.accept({
    streamId: 'stream-one',
    projectionVersion: 2,
    batchSeq: 1,
    operations: [
      { kind: 'checkpoint.load', externalSessionId: 'native-one' },
      {
        kind: 'snapshot.begin',
        snapshotId: 'capture-one',
        sessionId: 'session-one',
        throughSeq: 12,
        meta: { externalSessionId: 'native-one', title: 'hello' },
      },
      {
        kind: 'snapshot.items',
        snapshotId: 'capture-one',
        sessionId: 'session-one',
        items: [{ id: 'item-one', sessionId: 'session-one', content: 'hello' }],
      },
      {
        kind: 'snapshot.commit',
        snapshotId: 'capture-one',
        sessionId: 'session-one',
        throughSeq: 12,
        totalItems: 1,
      },
      {
        kind: 'checkpoint.save',
        externalSessionId: 'native-one',
        checkpoint: cp,
      },
      {
        kind: 'notifications',
        notifications: [
          { method: 'session.inventory.complete', params: { complete: true } },
        ],
      },
    ],
  })
  await until(() => calls.some(([method]) => method === 'runtime.sync.ack'))
  assert.equal(healthy, true)
  assert.equal(ingested[0].method, 'session.meta.upsert')
  assert.equal(ingested[1].method, 'timeline.sync')
  assert.equal(ingested[1].params.items[0].content, 'hello')
  assert.equal(calls.at(-1)[1].checkpoint, null)
  const filename =
    createHash('sha256').update('native-one').digest('hex') + '.json'
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, filename), 'utf8')),
    cp,
  )
})

test('incomplete snapshots never ACK or replace durable history; checkpoints reject foreign versions', async (t) => {
  const directory = await temporary(t)
  const calls = [],
    ingested = []
  let subscriptions = 0
  const client = {
    request: async (method, params) => {
      calls.push([method, params])
      if (method === 'runtime.sync.subscribe')
        return {
          streamId: `stream-${++subscriptions}`,
          projectionVersion: 2,
          checkpointVersion: 1,
        }
      return {}
    },
  }
  const sync = new BridgeSync({
    client,
    directory,
    ingest: async (events) => ingested.push(...events),
    healthy: async () => {},
    failed: () => {},
  })
  t.after(() => sync.stop())
  await sync.start()
  sync.accept({
    streamId: 'stream-1',
    projectionVersion: 2,
    batchSeq: 1,
    operations: [
      {
        kind: 'snapshot.begin',
        snapshotId: 'capture',
        sessionId: 'session',
        throughSeq: 1,
        meta: { externalSessionId: 'native' },
      },
      {
        kind: 'snapshot.commit',
        snapshotId: 'capture',
        sessionId: 'session',
        throughSeq: 1,
        totalItems: 2,
      },
    ],
  })
  await until(() => subscriptions === 2)
  assert.equal(ingested.length, 0)
  assert.equal(
    calls.some(([method]) => method === 'runtime.sync.ack'),
    false,
  )
  assert.equal(
    checkpoint({
      version: 1,
      projectionVersion: 1,
      throughSeq: 1,
      historyHash: 'a'.repeat(64),
      settled: true,
    }),
    null,
  )
})
