import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

async function assertInteractionCarrier(endpoint) {
  const socket = createConnection({ host: endpoint.host, port: endpoint.port })
  const pending = new Map()
  let nextId = 0
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      const waiter = pending.get(frame.id)
      if (!waiter) continue
      pending.delete(frame.id)
      clearTimeout(waiter.timer)
      if (frame.error) waiter.reject(new Error(frame.error.message))
      else waiter.resolve(frame.result)
    }
  })
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Runtime request timed out: ${method}`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      socket.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      )
    })
  try {
    await once(socket, 'connect')
    await request('initialize', {
      authToken: endpoint.token,
      protocolVersion: '1.0',
      runtime: 'dsh',
      connectorId: 'headless-interaction-check',
    })
    let capabilities
    const deadline = Date.now() + 5000
    do {
      capabilities = await request('runtime.getCapabilities')
      if (capabilities.metadata.approval && capabilities.metadata.userQuestions)
        break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.equal(capabilities.metadata.approval, true)
    assert.equal(capabilities.metadata.userQuestions, true)
    assert.equal(
      capabilities.capabilities.find(
        (entry) => entry.capabilityId === 'session.interaction.approval',
      ).supported,
      true,
    )
  } finally {
    socket.destroy()
    for (const waiter of pending.values()) clearTimeout(waiter.timer)
  }
}

test(
  'pure Node server composition boots one complete Host with its real runtime Bridge',
  { timeout: 60000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'superdsh-server-中文-'))
    const secret = 'test-loopback-capability'
    const catalog = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${secret}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ scope: 'a'.repeat(64), providers: [], default: null }),
      )
    })
    catalog.listen(0, '127.0.0.1')
    await once(catalog, 'listening')
    const port = catalog.address().port
    let output = ''
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../host.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          DSH_HOME: home,
          SUPERDSH_MODEL_GATEWAY: JSON.stringify({
            origin: `http://127.0.0.1:${port}`,
            secret,
          }),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Host startup timeout: ' + output)),
          45000,
        )
        function capture(chunk) {
          output = (output + chunk.toString()).slice(-20000)
          if (output.includes('SUPERDSH_AGENT_HOST_READY')) {
            clearTimeout(timer)
            resolve()
          }
        }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`Host exited ${code}: ${output}`))
        })
      })
      const endpoint = JSON.parse(
        await readFile(
          join(home, 'agents-anywhere', 'bridge', 'endpoint.json'),
          'utf8',
        ),
      )
      assert.equal(endpoint.host, '127.0.0.1')
      assert.equal(typeof endpoint.port, 'number')
      assert.equal(endpoint.version, 1)
      // Real Host + Gateway + pinned Bridge, not a stubbed capability response.
      await assertInteractionCarrier(endpoint)
      const manifest = JSON.parse(
        await readFile(
          join(home, 'profiles', 'server-agent', 'package.json'),
          'utf8',
        ),
      )
      assert.deepEqual(manifest.dsh.profile.bundles, [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
      ])
      assert.equal(output.includes(secret), false)
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null && child.signalCode === null)
        await once(child, 'exit')
      await new Promise((resolve) => catalog.close(resolve))
      await rm(home, { recursive: true, force: true })
    }
  },
)
