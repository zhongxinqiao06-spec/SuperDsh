/** Headless integration of the product-owned account Bridge against the installed runtime. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DesktopHostProcess } from '../lib/backend/host-process.js'
import { NextProfiles } from '../lib/backend/profiles.js'
import { cleanupDisposableTree } from '../lib/backend/disposable-tree.js'
import { desktopRuntimeAssets } from '../lib/main/installation.js'
import { authenticateWebHost } from '../lib/backend/web-auth.js'
import { accountEnvironment } from '../lib/backend/platform-environment.js'
const desktop = fileURLToPath(new URL('../../', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(join(desktop, 'plugins/harness/package.json'))
const home = mkdtempSync(join(tmpdir(), 'superdsh-managed-runtime-'))
const fixtureRoot = join(home, 'fixture')
mkdirSync(fixtureRoot)
await require('tar').x({
  file: join(
    root,
    'vendor/dsh-runtime/0.1.7-alpha.2/deepseek-ai-dsh-llm-mock-server-0.1.7-alpha.2.tgz',
  ),
  cwd: fixtureRoot,
  strict: true,
  filter: (path) =>
    ['package/package.json', 'package/lib/index.js'].includes(path),
})
const { startMockLlmServer } = await import(
  pathToFileURL(join(fixtureRoot, 'package/lib/index.js'))
)
const personalFixture = await startMockLlmServer({
  sequence: ['success', 'success'],
  successText:
    'The original local DeepSeek session still works after platform logout.',
})
const profiles = new NextProfiles(home)
const directory = profiles.ensure('desktop')
profiles.setFeatures('desktop', { market: false, remoteControl: true })
writeFileSync(
  join(directory, 'cordis.patch.yml'),
  JSON.stringify([
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    {
      id: 'llm-deepseek',
      config: {
        baseURL: personalFixture.baseURL,
        apiKeyEnv: 'SUPERDSH_FIXTURE_KEY',
        thinking: 'disabled',
        reasoningEffort: 'off',
        retryPolicy: { mode: 'normal', maxRetries: 0 },
      },
    },
    {
      id: 'agent-default-model',
      config: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'off',
      },
    },
  ]),
)
const secret = randomBytes(32).toString('base64url')
let scope = null
const platformRequests = []
const modelGateway = createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${secret}`)
  if (request.url !== '/catalog') {
    assert.equal(
      request.url,
      `/scopes/${scope}/providers/test/openai-completions/chat/completions`,
    )
    platformRequests.push(request.url)
    response.setHeader('content-type', 'text/event-stream')
    response.end(
      [
        {
          id: 'platform-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'Account-scoped platform model reply.',
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'platform-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    )
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      scope,
      providers: scope
        ? [
            {
              providerId: 'test',
              name: 'Test',
              protocol: 'openai-completions',
              models: [{ modelId: 'mock', name: 'Mock model' }],
            },
          ]
        : [],
      default: null,
    }),
  )
})
modelGateway.listen(0, '127.0.0.1')
await once(modelGateway, 'listening')
let diagnostics = ''
const token = randomBytes(32).toString('base64url')
const host = new DesktopHostProcess(
  process.execPath,
  desktop,
  directory,
  undefined,
  {
    ...accountEnvironment(process.env, home),
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    SUPERDSH_FIXTURE_KEY: 'local-fixture-only',
    DEEPSEEK_API_KEY: 'local-fixture-only',
    DEEPSEEK_BASE_URL: personalFixture.baseURL,
    SUPERDSH_PLATFORM_MANAGED: '1',
    SUPERDSH_MODEL_GATEWAY: JSON.stringify({
      origin: `http://127.0.0.1:${modelGateway.address().port}`,
      secret,
    }),
    SUPERDSH_CLIENT_MANIFEST: desktopRuntimeAssets(
      join(desktop, 'package.json'),
    ).frontendManifest,
    DSH_NEXT_NATIVE_TOKEN: token,
    DSH_NEXT_PREFERENCES: '{}',
    DSH_NEXT_TRUSTED_HOSTS: '[]',
  },
  undefined,
  undefined,
  undefined,
  fileURLToPath(import.meta.resolve('@superdsh/core/backend/host')),
  undefined,
  undefined,
  (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-16000)
  },
)
let socket
try {
  const ready = await host.start()
  const origin = new URL(ready.url).origin
  const cookie = await authenticateWebHost(ready.url, token)
  const rpc = async (method, args = {}) => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-dsh-desktop-renderer': token,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args },
      }),
    })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const value = async (method, request) => {
    const result = await rpc(method, request === undefined ? {} : { request })
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`)
    return result.value
  }
  const nativeEvents = async (sessionId) => {
    const projections = await value('session/projections', { sessionId })
    const page = await value('session/page', {
      address: { kind: 'session', sessionId },
      throughSeq: projections.asOfSeq,
      maxMessages: 100,
    })
    return page.records.map((record) => record.event)
  }
  const promptAndWait = async (sessionId, count) => {
    await value('session/prompt', {
      sessionId,
      requestId: crypto.randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Verify this exact model route.' }],
    })
    for (let attempt = 0; attempt < 200; attempt++) {
      const events = await nativeEvents(sessionId)
      if (events.filter((event) => event.type === 'turn/end').length >= count)
        return events
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Native journal did not finish ${sessionId} turn ${count}`)
  }
  const assertRetiredSession = async () => {
    const denied = await rpc('session/prompt', {
      request: {
        sessionId: 'platform-sticky',
        requestId: crypto.randomUUID(),
        mode: 'queue',
        content: [
          { type: 'text', text: 'This old account route must never execute.' },
        ],
      },
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'session/model-unavailable')
    assert.match(denied.error.message, /no adapter serves provider/)
    const events = await nativeEvents('platform-sticky')
    assert.equal(
      events.filter((event) => event.type === 'assistant/message').length,
      1,
    )
    assert.equal(
      events.filter((event) => event.type === 'turn/end').length,
      1,
      'A retired model is rejected before creating another native turn',
    )
  }
  const personalSession = (
    await value('session/create', {
      sessionId: 'personal-before-and-after',
      cwd: directory,
    })
  ).sessionId
  const before = await promptAndWait(personalSession, 1)
  assert.equal(
    before.filter((event) => event.type === 'assistant/message').length,
    1,
  )
  const personalDefault = (await value('session/modelCatalog')).default
  assert.equal(personalDefault.provider, 'deepseek-official')
  const plugins = await rpc('pluginManager/listPlugins')
  assert.equal(plugins.ok, true)
  assert(
    plugins.value.some(
      (plugin) => plugin.moduleName === '@superdsh/harness/managed-bridge',
    ),
  )
  assert(
    plugins.value.some(
      (plugin) => plugin.moduleName === '@superdsh/harness/managed-models',
    ),
  )
  const endpointPath = join(home, 'agents-anywhere', 'bridge', 'endpoint.json')
  for (let attempt = 0; !existsSync(endpointPath) && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'))
  socket = createConnection({ host: endpoint.host, port: endpoint.port })
  await once(socket, 'connect')
  let seq = 0,
    buffer = ''
  const pending = new Map()
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'),
        line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const frame = JSON.parse(line)
      if (frame.id && pending.has(frame.id)) {
        const { resolve, reject, timer } = pending.get(frame.id)
        pending.delete(frame.id)
        clearTimeout(timer)
        if (frame.error) reject(new Error(JSON.stringify(frame.error)))
        else resolve(frame.result)
      }
    }
  })
  const bridge = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => reject(new Error('Bridge timeout')), 15000)
      pending.set(id, { resolve, reject, timer })
      socket.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      )
    })
  const init = await bridge('initialize', {
    authToken: endpoint.token,
    protocolVersion: '1.0',
    runtime: 'dsh',
    connectorId: 'isolated-test',
  })
  assert.equal(init.features.readOnly, false)
  const managedProviders = async () =>
    (await bridge('catalog.listModels', {})).models
      .map((model) => model.metadata?.provider)
      .filter((provider) => provider?.startsWith('superdsh-'))
  await host.refreshPlatformModels()
  assert.deepEqual(await managedProviders(), [])
  for (const key of ['a'.repeat(64), 'b'.repeat(64)]) {
    scope = key
    await host.refreshPlatformModels()
    assert.deepEqual(await managedProviders(), [`superdsh-${key}-test`])
    assert.deepEqual(
      await host.start(),
      ready,
      'Identity changes keep the original Host generation',
    )
    assert.deepEqual(
      JSON.parse(readFileSync(endpointPath, 'utf8')),
      endpoint,
      'Identity changes keep the original RuntimeBridge endpoint',
    )
    assert.equal(await host.platformTasks('inspect'), false)
    if (key === 'a'.repeat(64)) {
      await value('session/create', {
        sessionId: 'platform-sticky',
        cwd: directory,
      })
      await value('session/selectModel', {
        sessionId: 'platform-sticky',
        provider: `superdsh-${key}-test`,
        model: 'mock',
      })
      assert.deepEqual(
        (await value('session/modelCatalog')).default,
        personalDefault,
        'A platform session selection must not change the personal global default',
      )
      const platformEvents = await promptAndWait('platform-sticky', 1)
      assert.equal(
        platformEvents.filter((event) => event.type === 'assistant/message')
          .length,
        1,
      )
      assert.equal(platformRequests.length, 1)
    } else {
      const personalCalls = personalFixture.requests.length
      const stale = await rpc('session/selectModel', {
        request: {
          sessionId: 'platform-sticky',
          provider: `superdsh-${'a'.repeat(64)}-test`,
          model: 'mock',
        },
      })
      assert.equal(stale.ok, false)
      assert.equal(stale.error.code, 'session/model-unavailable')
      assert.match(stale.error.message, /no adapter registered/)
      await assertRetiredSession()
      assert.equal(
        personalFixture.requests.length,
        personalCalls,
        'An invalidated platform session must not bill the personal provider',
      )
      assert.equal(
        platformRequests.length,
        1,
        'An invalidated session must not use the replacement account provider',
      )
    }
  }
  scope = null
  await host.refreshPlatformModels()
  assert.deepEqual(await managedProviders(), [])
  assert.equal(await host.platformTasks('stop'), false)
  assert.deepEqual(
    (await value('session/modelCatalog')).default,
    personalDefault,
  )
  const after = await promptAndWait(personalSession, 2)
  const assistants = after.filter((event) => event.type === 'assistant/message')
  assert.equal(
    assistants.length,
    2,
    'Logout must preserve the same native personal session and its second durable reply',
  )
  assert.ok(
    assistants[1].data.message.content.some(
      (part) =>
        part.type === 'text' &&
        part.text.includes('still works after platform logout'),
    ),
  )
  assert.equal(personalFixture.requests.length, 2)
  await assertRetiredSession()
  assert.equal(personalFixture.requests.length, 2)
  assert.equal(
    (
      await fetch(`${origin}/api/agentsAnywhere/status`, {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          'x-dsh-desktop-renderer': token,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'agentsAnywhere/status',
          payload: { args: {} },
        }),
      })
    ).status,
    404,
    'Managed account must not expose optional AA onboarding owner',
  )
  socket.destroy()
  socket = undefined
  await host.stop(true)
  assert(
    !existsSync(endpointPath),
    'Stopped Host must withdraw its bridge endpoint',
  )
  process.stdout.write(
    'Managed Host integration passed: signed-out → Alice → Bob → signed-out on one real Host; scoped native selections preserve the personal global default, retired sessions never fall back, and the same native DeepSeek session persists its second assistant reply after logout.\n',
  )
} catch (error) {
  process.stderr.write(diagnostics)
  throw error
} finally {
  socket?.destroy()
  await host.stop()
  modelGateway.closeAllConnections()
  await new Promise((resolve) => modelGateway.close(resolve))
  await personalFixture.close()
  cleanupDisposableTree(home)
}
