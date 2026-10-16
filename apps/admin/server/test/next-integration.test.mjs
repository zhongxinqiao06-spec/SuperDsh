import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import WebSocket from 'ws'
import { withTestDatabase } from './support/database.mjs'
import { verifyBusinessAgentManagement } from './support/business-agents-web.mjs'

const production = process.env.SUPERDSH_NODE_WEB_TEST === 'production'

async function availablePort() {
  const probe = createServer()
  await new Promise((done) => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}

test(
  'unified CLI manages business agents in real browser dialogs and renders a real Host streamed reply',
  {
    skip: !['1', 'production'].includes(process.env.SUPERDSH_NODE_WEB_TEST)
      ? 'run the complete isolated integration runner'
      : false,
    timeout: 300_000,
  },
  async (t) => {
    let cleanupDatabase, child, browser
    const db = await withTestDatabase({
      after: (fn) => {
        cleanupDatabase = fn
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'superdsh-next-中文-'))
    const adminRoot = fileURLToPath(new URL('../../', import.meta.url))
    const distName = production ? '.next' : `.next-node-check-${process.pid}`
    const tsconfig = await readFile(join(adminRoot, 'tsconfig.json'), 'utf8')
    const nextEnv = await readFile(join(adminRoot, 'next-env.d.ts'), 'utf8')
    let releaseReply
    const replyGate = new Promise((done) => {
      releaseReply = done
    })
    let modelRequests = 0
    const model = createHttpServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      modelRequests += 1
      await replyGate
      if (response.destroyed) return
      if (!body.stream) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Browser test conversation',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        )
        return
      }
      response.setHeader('content-type', 'text/event-stream')
      for (const chunk of [
        {
          choices: [
            {
              delta: { role: 'assistant', content: 'BROWSER_AGENT_REPLY_OK' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        },
      ])
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise((done) => model.listen(0, '127.0.0.1', done))
    const modelOrigin = `http://127.0.0.1:${model.address().port}`
    let logs = ''
    let exited
    let stoppedCleanly = false
    t.after(async () => {
      releaseReply()
      try {
        await browser?.close()
        if (child?.exitCode === null && child?.signalCode === null) {
          child.send({ type: 'superdsh:shutdown' })
          const timer = setTimeout(() => child.kill(), 20_000)
          const status = await exited
          clearTimeout(timer)
          stoppedCleanly = status === 0
        }
      } finally {
        model.closeAllConnections()
        await new Promise((done) => model.close(done))
        await cleanupDatabase()
        await writeFile(join(adminRoot, 'tsconfig.json'), tsconfig)
        await writeFile(join(adminRoot, 'next-env.d.ts'), nextEnv)
        assert.equal(dirname(resolve(root)), resolve(tmpdir()))
        assert.ok(root.includes('superdsh-next-中文-'))
        await rm(root, { recursive: true, force: true })
        if (!production) {
          const cache = resolve(adminRoot, distName)
          assert.equal(dirname(cache), resolve(adminRoot))
          assert.ok(distName.startsWith('.next-node-check-'))
          await rm(cache, { recursive: true, force: true })
        }
      }
      assert.ok(
        stoppedCleanly,
        `CLI did not shut down cleanly: ${logs.slice(-2000)}`,
      )
    })
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const envFile = join(root, 'development.env')
    await writeFile(envFile, '# Isolated integration environment\n')
    child = fork(
      resolve(adminRoot, '../../scripts/server.mjs'),
      [production ? 'start' : 'dev'],
      {
        cwd: adminRoot,
        execArgv: [],
        silent: true,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_ENV: production ? 'production' : 'development',
          SUPERDSH_SERVER_DEV_ENV: envFile,
          ...(production ? { SUPERDSH_SERVER_ENV: envFile } : {}),
          NEXT_DIST_DIR: distName,
          AGENT_SERVER_DB_URL: db.testUrl,
          AGENT_SERVER_REDIS_URL: process.env.SUPERDSH_NODE_TEST_REDIS_URL,
          SUPERDSH_QDRANT_URL: process.env.SUPERDSH_NODE_TEST_QDRANT_URL,
          AGENT_SERVER_SECRET: randomBytes(32).toString('hex'),
          SUPERDSH_MODEL_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
          SUPERDSH_SERVER_DATA_DIR: root,
          AGENT_SERVER_FILES_LOCAL_ROOT: join(root, 'files'),
          SUPERDSH_SERVER_HOST: '127.0.0.1',
          SUPERDSH_SERVER_PORT: String(port),
          AGENT_SERVER_PORT: String(port),
          AGENT_SERVER_PUBLIC_ORIGIN: origin,
          AGENT_SERVER_SETUP_TOKEN: 'synthetic-token',
          SUPERDSH_BOOTSTRAP_DEV_ADMIN: '0',
          SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS: modelOrigin,
        },
      },
    )
    exited = new Promise((done) => child.once('exit', (code) => done(code)))
    child.stdout.on('data', (chunk) => {
      logs = (logs + chunk).slice(-20_000)
    })
    child.stderr.on('data', (chunk) => {
      logs = (logs + chunk).slice(-20_000)
    })
    await new Promise((done, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`CLI readiness timed out: ${logs.slice(-2000)}`)),
        45_000,
      )
      child.once('message', (message) => {
        clearTimeout(timer)
        assert.equal(message.type, 'superdsh:ready')
        done()
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`CLI exited (${code}): ${logs.slice(-2000)}`))
      })
      child.once('error', reject)
    })
    const registration = await fetch(`${origin}/api/v2/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SuperDsh-Agent-Preparation': 'deferred',
      },
      body: JSON.stringify({
        username: 'alice',
        displayName: 'Alice',
        password: 'synthetic-password',
        setupToken: 'synthetic-token',
      }),
    })
    assert.equal(registration.status, 200, await registration.text())
    const { chromium } = createRequire(
      new URL('../../../desktop/package.json', import.meta.url),
    )('playwright')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const failures = []
    page.on('pageerror', (error) => failures.push(error.message))
    try {
      await page.goto(origin, {
        waitUntil: 'domcontentloaded',
        timeout: 180_000,
      })
    } catch (error) {
      throw new Error(`${error.message}\n${logs.slice(-4000)}`, {
        cause: error,
      })
    }
    await page.locator('#hero-title').waitFor({ state: 'visible' })
    await page
      .getByRole('link', { name: '进入工作台', exact: true })
      .first()
      .click()
    assert.equal(new URL(page.url()).hash, '#/login')
    await page
      .getByRole('button', { name: /登录|log in|sign in/i })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
    const result = await page.evaluate(async () => {
      const login = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SuperDsh-Agent-Preparation': 'deferred',
        },
        body: JSON.stringify({
          identifier: 'alice',
          password: 'synthetic-password',
        }),
      })
      const value = await login.json()
      const menus = await fetch('/api/v2/navigation', {
        headers: { Authorization: `Bearer ${value.accessToken}` },
      })
      return {
        login: login.status,
        menus: menus.status,
        navigation: await menus.json(),
        hasRefreshInBody: !!value.refreshToken,
      }
    })
    assert.equal(result.login, 200)
    assert.equal(result.menus, 200)
    assert.equal(result.hasRefreshInBody, false)
    assert.ok(JSON.stringify(result.navigation).includes('access.users'))
    assert.ok(
      (await page.context().cookies()).some(
        (cookie) => cookie.name === 'superdsh_refresh' && cookie.httpOnly,
      ),
    )
    assert.equal((await db.query('SELECT * FROM server_agents')).length, 0)
    const code = await new Promise((done, reject) => {
      const socket = new WebSocket(
        `${origin.replace('http:', 'ws:')}/api/v2/connector/ws`,
        { handshakeTimeout: 5000 },
      )
      socket.on('open', () => {
        socket.close()
        reject(new Error('anonymous Connector WebSocket was accepted'))
      })
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        socket.terminate()
        done(response.statusCode)
      })
      socket.on('error', () => {})
    })
    assert.equal(code, 401)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const configuredAgentId = await verifyBusinessAgentManagement(page).catch(
      async (error) => {
        t.diagnostic((await page.locator('body').innerText()).slice(-6000))
        t.diagnostic(logs.slice(-4000))
        throw error
      },
    )
    assert.equal(
      (await db.query('SELECT * FROM server_agents')).length,
      0,
      'management must not prepare a user runtime',
    )
    // Exercise the actual chat page and its WebSocket parser, not just the
    // database/API result. A missing envelope field used to leave it running
    // forever even though the full Host had already finished the response.
    const configured = await page.evaluate(async (baseUrl) => {
      const refreshed = await fetch('/api/v2/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SuperDsh-Agent-Preparation': 'deferred',
        },
        body: '{}',
      })
      const auth = await refreshed.json()
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      }
      const saved = await fetch('/api/v2/models/personal/providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Browser fixture',
          protocol: 'openai-completions',
          baseUrl,
          apiKey: 'synthetic-only',
          models: [
            {
              modelId: 'browser-test',
              name: 'Browser test model',
              maxTokens: 1024,
              contextWindow: 32768,
            },
          ],
        }),
      })
      const provider = await saved.json()
      const selected = await fetch('/api/v2/models/personal/default', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: {
            providerId: provider.providerId,
            modelId: 'browser-test',
          },
        }),
      })
      return { saved: saved.status, selected: selected.status }
    }, modelOrigin)
    assert.deepEqual(configured, { saved: 200, selected: 200 })
    const streamEvents = []
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/sessions/')) return
      socket.on('framereceived', ({ payload }) => {
        try {
          streamEvents.push(JSON.parse(String(payload)))
        } catch {
          /* HMR is not a session event. */
        }
      })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      window.location.hash = '#/workspace'
    })
    const prompt = page.getByPlaceholder(/描述任务|Describe the task/)
    await prompt.waitFor({ state: 'visible', timeout: 130_000 })
    await page
      .waitForFunction(
        () => {
          const input = document.querySelector(
            'textarea[placeholder="描述任务..."],textarea[placeholder="Describe the task..."]',
          )
          return input && !input.disabled
        },
        undefined,
        { timeout: 130_000 },
      )
      .catch(async (error) => {
        t.diagnostic((await page.locator('body').innerText()).slice(-6000))
        t.diagnostic(logs.slice(-4000))
        throw error
      })
    await prompt.fill('Verify the browser receives a completed streamed reply.')
    const agentPicker = page.getByRole('combobox', {
      name: /^(业务智能体|Business agent)$/,
    })
    await agentPicker.selectOption(configuredAgentId)
    assert.equal(await agentPicker.inputValue(), configuredAgentId)
    const send = page.getByRole('button', { name: /^(发送任务|Send task)$/ })
    await page.waitForFunction(
      () => {
        const button = document.querySelector(
          'button[aria-label="发送任务"],button[aria-label="Send task"]',
        )
        return button && !button.disabled
      },
      undefined,
      { timeout: 130_000 },
    )
    await send.click()
    const interrupt = page.getByRole('button', { name: /^(中断|Interrupt)$/ })
    await interrupt.waitFor({ state: 'visible', timeout: 30_000 })
    const requestDeadline = Date.now() + 10_000
    while (!modelRequests && Date.now() < requestDeadline)
      await new Promise((done) => setTimeout(done, 50))
    assert.ok(modelRequests > 0)
    const conversationUrl = page.url()
    releaseReply()
    await page
      .locator('p')
      .filter({ hasText: 'BROWSER_AGENT_REPLY_OK' })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
    await interrupt.waitFor({ state: 'hidden', timeout: 15_000 })
    assert.equal(
      page.url(),
      conversationUrl,
      'completion must render without a reload or navigation',
    )
    assert.ok(
      streamEvents.some(
        (event) =>
          event.type === 'session.subscribed' &&
          event.protocolVersion === '1.0',
      ),
    )
    await page
      .getByText('Browser configured agent · v1', { exact: true })
      .waitFor()
    assert.ok(
      streamEvents.some(
        (event) =>
          event.type === 'runtime.state.updated' &&
          event.payload?.state?.status === 'idle',
      ),
    )
    assert.ok(
      streamEvents.some(
        (event) =>
          event.type.startsWith('timeline.item_') &&
          event.payload?.item?.role === 'assistant',
      ),
    )
    assert.deepEqual(failures, [])
    await browser.close()
    browser = undefined
    child.send({ type: 'superdsh:shutdown' })
    const timeout = setTimeout(() => child.kill(), 20_000)
    assert.equal(await exited, 0, logs.slice(-2000))
    clearTimeout(timeout)
    stoppedCleanly = true
    await assert.rejects(fetch(`${origin}/api/v2/health/live`))
  },
)
