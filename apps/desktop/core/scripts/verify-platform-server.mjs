/** Real API + product Connector/Host integration. Requires an explicitly supplied disposable server account. */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformAccount } from '../lib/main/platform-account.js'
import { PlatformConnector } from '../lib/main/platform-connector.js'
import { PlatformSpaces } from '../lib/main/platform-spaces.js'
import { PlatformRemote } from '../lib/main/platform-remote.js'
import { PlatformModelGateway } from '../lib/main/platform-model-gateway.js'
import { DesktopHostProcess } from '../lib/backend/host-process.js'
import { NextProfiles } from '../lib/backend/profiles.js'
import { cleanupDisposableTree } from '../lib/backend/disposable-tree.js'
import { accountEnvironment } from '../lib/backend/platform-environment.js'
import { authenticateWebHost } from '../lib/backend/web-auth.js'
import { desktopRuntimeAssets } from '../lib/main/installation.js'

const configIndex = process.argv.indexOf('--config')
assert(
  configIndex > 0,
  'Supply --config with a disposable {origin, identifier, password} JSON fixture',
)
const fixture = JSON.parse(
  readFileSync(resolve(process.argv[configIndex + 1]), 'utf8'),
)
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(fixture.origin).hostname,
  ),
  'Verification accepts only an isolated loopback server',
)
assert(
  !process.argv.includes('--python'),
  'Product Python selection must be tested without a caller override',
)
const sandbox = mkdtempSync(join(tmpdir(), 'superdsh-real-platform-'))
const key = randomBytes(32)
// The ephemeral cipher exercises persisted account isolation, not OS safeStorage.
const secrets = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
  },
  decryptString(value) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([
      cipher.update(value.subarray(28)),
      cipher.final(),
    ]).toString()
  },
}
let host,
  connector,
  account,
  gateway,
  remote,
  diagnostics = ''
const unwrap = (value) => value.result ?? value
let allowActivation = true
try {
  const localHome = join(sandbox, 'local')
  const spaces = new PlatformSpaces(localHome, localHome)
  account = new PlatformAccount(
    spaces,
    secrets,
    async () => {
      throw new Error('Browser login is outside this headless verification')
    },
    {
      beforeActivate: async () => {
        if (!allowActivation) return false
        if (host && (await host.platformTasks('inspect')))
          await host.platformTasks('stop')
        await remote?.close()
        await connector?.stop()
        gateway?.invalidateIdentity()
        return true
      },
      onActivated: async () => {
        await host?.refreshPlatformModels()
      },
    },
  )
  account.initialize()
  connector = new PlatformConnector(account, spaces.home, secrets, {
    diagnostic: (message) => {
      diagnostics = (diagnostics + message).slice(-16000)
    },
  })
  gateway = new PlatformModelGateway(
    account,
    () => connector.state().connectorId,
  )
  await gateway.start()
  const gatewayCapability = { ...gateway.descriptor() }
  const signedOutCatalog = await fetch(`${gatewayCapability.origin}/catalog`, {
    headers: { authorization: `Bearer ${gatewayCapability.secret}` },
  }).then((value) => value.json())
  assert.deepEqual(signedOutCatalog.providers, [])
  const profiles = new NextProfiles(spaces.home),
    directory = profiles.ensure('desktop')
  profiles.setFeatures('desktop', { market: false, remoteControl: false })
  const nativeModelOrigin = fixture.nativeModelOrigin
  if (nativeModelOrigin) {
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(nativeModelOrigin).hostname,
      ),
    )
    writeFileSync(
      join(directory, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        {
          id: 'llm-deepseek',
          config: {
            baseURL: nativeModelOrigin + '/anthropic',
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
  }
  const desktop = fileURLToPath(new URL('../../', import.meta.url))
  const nativeToken = randomBytes(32).toString('base64url')
  host = new DesktopHostProcess(
    process.execPath,
    desktop,
    directory,
    undefined,
    {
      ...accountEnvironment(
        Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !/^(DEEPSEEK_|AGENT_|DSH_|SUPERDSH_)/.test(name),
          ),
        ),
        spaces.home,
      ),
      ...(nativeModelOrigin
        ? {
            DEEPSEEK_API_KEY: 'local-fixture-only',
            SUPERDSH_FIXTURE_KEY: 'local-fixture-only',
            DEEPSEEK_BASE_URL: nativeModelOrigin + '/anthropic',
          }
        : {}),
      DSH_HOME: spaces.home,
      DSH_TELEMETRY_DISABLED: '1',
      SUPERDSH_PLATFORM_MANAGED: '1',
      SUPERDSH_MODEL_GATEWAY: JSON.stringify(gateway.descriptor()),
      SUPERDSH_CLIENT_MANIFEST: desktopRuntimeAssets(
        join(desktop, 'package.json'),
      ).frontendManifest,
      DSH_NEXT_NATIVE_TOKEN: nativeToken,
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
  const ready = await host.start()
  const hostOrigin = new URL(ready.url).origin
  const cookie = await authenticateWebHost(ready.url, nativeToken)
  const nativeSessionId = 'inline-existing-' + crypto.randomUUID()
  const nativeRpc = async (method, args) => {
    const response = await fetch(`${hostOrigin}/api/${method}`, {
      method: 'POST',
      headers: {
        cookie,
        origin: hostOrigin,
        'content-type': 'application/json',
        'x-dsh-desktop-renderer': nativeToken,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(15_000),
    }).then((value) => value.json())
    assert.equal(
      response.result.ok,
      true,
      `${method}: ${JSON.stringify(response.result)}`,
    )
    return response.result.value
  }
  await nativeRpc('session/create', {
    request: { sessionId: nativeSessionId, cwd: directory },
  })
  const nativePrompt = async () => {
    await nativeRpc('session/prompt', {
      request: {
        sessionId: nativeSessionId,
        requestId: crypto.randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: 'Reply with SUPERDSH_CHAT_ROUNDTRIP' }],
      },
    })
    for (let attempt = 0; await host.platformTasks('inspect'); attempt++) {
      assert(attempt < 200, 'Native local task did not finish')
      await delay(100)
    }
  }
  if (nativeModelOrigin) await nativePrompt()
  const hostPid = host.child?.pid
  assert(hostPid, 'Host diagnostics must identify the actual child')
  await account.loginWithPassword({
    origin: fixture.origin,
    identifier: fixture.identifier,
    password: fixture.password,
  })
  const session = account.user
  assert.equal(
    session.resetRequired,
    false,
    'Fixture must have a permanent password',
  )
  assert.equal((await account.json('/auth/me')).userId, session.userId)
  assert.equal(spaces.home, localHome)
  // Simulate the old Electron data directory's inaccessible credential key.
  // These are disposable ciphertext bytes, never a real user binding.
  const oldBindingDirectory = join(
    spaces.homeFor(account.identity().key),
    'platform-connector',
  )
  const oldBindingPath = join(oldBindingDirectory, 'binding.enc.json')
  const unreadableLegacy = JSON.stringify({
    encrypted: randomBytes(64).toString('base64'),
  })
  mkdirSync(oldBindingDirectory, { recursive: true })
  writeFileSync(oldBindingPath, unreadableLegacy)
  await connector.connect()
  assert.equal(
    readFileSync(oldBindingPath, 'utf8'),
    unreadableLegacy,
    'An inaccessible legacy credential must be preserved instead of blocking login',
  )
  assert.equal(
    connector.state().connectorOnline,
    true,
    'Connection completion requires confirmed server presence',
  )
  assert.equal(connector.state().connectorPhase, 'ready')
  const connectorId = connector.state().connectorId
  assert(connectorId)
  const confirmedDevice = await account.json(
    `/connectors/${encodeURIComponent(connectorId)}`,
  )
  assert.equal(confirmedDevice.connector.status, 'online')
  assert.equal(confirmedDevice.connector.userId, session.userId)
  const events = []
  remote = new PlatformRemote(account, (event) => events.push(event))
  let existingCopy
  for (let attempt = 0; attempt < 120; attempt++) {
    const listed = await remote.request({
      operation: 'sessions',
      query: { limit: '100' },
    })
    existingCopy = listed.sessions.find(
      (row) => row.externalSessionId === nativeSessionId,
    )
    if (existingCopy) break
    await delay(250)
  }
  if (nativeModelOrigin) {
    assert(
      existingCopy,
      'Login must synchronize existing nonblank native history',
    )
    const existingHistory = await remote.request({
      operation: 'snapshot',
      sessionId: existingCopy.id,
    })
    assert(
      existingHistory.timeline.items.some(
        (item) =>
          item.role === 'assistant' &&
          JSON.stringify(item.content).includes(fixture.expectedReply),
      ),
      'The native personal model must work before platform login',
    )
  }
  const devices = await remote.request({ operation: 'devices' })
  assert(
    devices.connectors.some(
      (row) =>
        row.id === connectorId &&
        row.userId === session.userId &&
        row.status === 'online',
    ),
  )
  const runtimes = await remote.request({ operation: 'runtimes', connectorId })
  const runtime = runtimes.runtimes.find(
    (row) => row.runtimeType === 'dsh' && row.active,
  )
  assert(runtime, 'Product Connector must create its owned DSH runtime')
  const workspace = join(sandbox, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'roundtrip.txt'), 'original fixture\n')
  const listing = unwrap(
    await remote.request({
      operation: 'files',
      connectorId,
      body: { root: workspace, path: '.' },
    }),
  )
  assert(listing.entries.some((entry) => entry.name === 'roundtrip.txt'))
  const original = unwrap(
    await remote.request({
      operation: 'read-file',
      connectorId,
      query: { root: workspace },
      body: { path: 'roundtrip.txt', maxBytes: 1048576 },
    }),
  )
  assert.equal(original.content, 'original fixture\n')
  await remote.request({
    operation: 'write-file',
    connectorId,
    query: { root: workspace },
    body: {
      path: 'roundtrip.txt',
      content: 'updated fixture\n',
      ifMatch: original.sha256,
    },
  })
  assert.equal(
    readFileSync(join(workspace, 'roundtrip.txt'), 'utf8'),
    'updated fixture\n',
  )
  const terminal = unwrap(
    await remote.request({
      operation: 'create-terminal',
      connectorId,
      query: { root: workspace },
      body: { cols: 100, rows: 30, cwd: workspace },
    }),
  )
  const terminalId = terminal.terminalId ?? terminal.terminal?.terminalId
  assert(terminalId)
  await remote.request({
    operation: 'terminal-write',
    connectorId,
    terminalId,
    body: { data: 'echo SUPERDSH_ROUNDTRIP\r' },
  })
  let terminalOutput = ''
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = unwrap(
      await remote.request({
        operation: 'terminal-snapshot',
        connectorId,
        terminalId,
      }),
    )
    terminalOutput = Buffer.from(snapshot.dataBase64, 'base64').toString()
    if (terminalOutput.includes('SUPERDSH_ROUNDTRIP')) break
    await delay(100)
  }
  assert(terminalOutput.includes('SUPERDSH_ROUNDTRIP'))
  await remote.request({ operation: 'terminal-close', connectorId, terminalId })
  const catalog = await remote.request({ operation: 'model-catalog' })
  let primarySessionId
  let primaryNativeId
  if (fixture.verifyChat) {
    assert(
      catalog.default,
      'Chat verification requires a configured platform default model',
    )
    const runtimeId = runtime.id ?? runtime.runtimeId
    const modelCatalog = await remote.request({
      operation: 'runtime-models',
      connectorId,
      runtimeId,
    })
    const permissionCatalog = await remote.request({
      operation: 'runtime-permissions',
      connectorId,
      runtimeId,
    })
    const model = modelCatalog.catalog.models.find(
      (row) =>
        row.metadata?.provider ===
          `superdsh-${account.identity().key}-${catalog.default.providerId}` &&
        row.metadata?.model === catalog.default.modelId,
    )
    const permission = permissionCatalog.catalog.permissions.find(
      (row) => row.metadata?.preset === 'workspace-write',
    )
    assert(
      model && permission,
      'Default model and workspace permission must be available',
    )
    const project = (
      await remote.request({
        operation: 'create-project',
        body: {
          name: `Isolated verification ${crypto.randomUUID().slice(0, 8)}`,
          connectorId,
          workspacePath: workspace,
          manuallyCreated: true,
        },
      })
    ).project
    const created = await remote.request({
      operation: 'create-session',
      body: {
        connectorId,
        projectId: project.id,
        runtime: 'dsh',
        runtimeId,
        selections: {
          model: model.selectionId ?? model.id,
          permission: permission.selectionId ?? permission.id,
        },
        cwd: workspace,
        content: 'Reply with SUPERDSH_CHAT_ROUNDTRIP',
        clientMessageId: crypto.randomUUID(),
      },
    })
    assert(
      created.connectorResult?.ok !== false,
      JSON.stringify(created.connectorResult),
    )
    const sessionId = created.session.id
    primarySessionId = sessionId
    primaryNativeId = created.session.externalSessionId
    await remote.watch(sessionId)
    let snapshot
    const sawReply = () =>
      snapshot?.timeline?.items?.some(
        (item) =>
          item.role === 'assistant' &&
          JSON.stringify(item.content).includes(
            fixture.expectedReply ?? 'SUPERDSH_CHAT_ROUNDTRIP',
          ),
      )
    const sawServerEvent = () =>
      events.some((item) => item.event?.type !== 'superdsh.reconnected')
    for (let attempt = 0; attempt < 120; attempt++) {
      snapshot = await remote.request({ operation: 'snapshot', sessionId })
      if (sawReply() && sawServerEvent()) break
      await delay(500)
    }
    assert(
      sawServerEvent(),
      'Native ticketed session WebSocket must receive updates',
    )
    assert(sawReply(), 'Real server must persist the model response')
    primaryNativeId ??= snapshot.session.externalSessionId
    process.stdout.write(
      'Real server chat snapshot and ticketed WebSocket passed.\n',
    )
  }
  await account.loginWithPassword({
    origin: fixture.origin,
    identifier: fixture.identifier,
    password: fixture.password,
  })
  await connector.connect()
  assert.equal(
    connector.state().connectorId,
    connectorId,
    'Re-login must reuse the device',
  )
  assert.equal(host.child?.pid, hostPid)
  assert.deepEqual(gateway.descriptor(), gatewayCapability)
  await assert.rejects(
    account.loginWithPassword({
      origin: fixture.origin,
      identifier: fixture.identifier,
      password: crypto.randomUUID(),
    }),
    /用户名或密码/,
  )
  assert.equal(account.user.userId, session.userId)
  assert.equal(connector.state().connectorId, connectorId)
  assert.equal(
    host.child?.pid,
    hostPid,
    'Failed login leaves the native Host usable',
  )
  if (primaryNativeId) {
    const listed = await remote.request({
      operation: 'sessions',
      query: { limit: '100' },
    })
    assert.equal(
      listed.sessions.filter((row) => row.externalSessionId === primaryNativeId)
        .length,
      1,
      'Re-login cannot duplicate a synchronized native session',
    )
  }
  if (fixture.secondary && primarySessionId && primaryNativeId) {
    const primaryIdentity = account.identity().key
    allowActivation = false
    await account.loginWithPassword({
      origin: fixture.origin,
      ...fixture.secondary,
    })
    assert.equal(
      account.identity().key,
      primaryIdentity,
      'Cancelled change keeps the original account',
    )
    assert.equal(connector.state().connectorId, connectorId)
    allowActivation = true
    await account.loginWithPassword({
      origin: fixture.origin,
      ...fixture.secondary,
    })
    await connector.connect()
    assert.notEqual(
      connector.state().connectorId,
      connectorId,
      'Device ownership must remain separate',
    )
    assert.equal(spaces.home, localHome)
    let copied
    for (let attempt = 0; attempt < 120; attempt++) {
      const listed = await remote.request({
        operation: 'sessions',
        query: { limit: '100' },
      })
      copied = listed.sessions.find(
        (row) => row.externalSessionId === primaryNativeId,
      )
      if (copied) break
      await delay(250)
    }
    assert(copied, 'The new account must synchronize existing native history')
    assert.notEqual(
      copied.id,
      primarySessionId,
      'Cloud session identities cannot cross owners',
    )
    const copiedSnapshot = await remote.request({
      operation: 'snapshot',
      sessionId: copied.id,
    })
    assert(
      copiedSnapshot.timeline.items.some((item) =>
        JSON.stringify(item.content).includes(fixture.expectedReply),
      ),
    )
    await assert.rejects(() =>
      remote.request({ operation: 'snapshot', sessionId: primarySessionId }),
    )
    assert.equal(
      host.child?.pid,
      hostPid,
      'Account change must not restart Harness',
    )
    process.stdout.write(
      'One local Home synchronized to two isolated accounts without a Host restart; cancellation and ownership checks passed.\n',
    )
  }
  await account.logout()
  assert.equal(account.state().status, 'signed-out')
  assert.equal(host.child?.pid, hostPid, 'Logout keeps the native Host running')
  assert.deepEqual(gateway.descriptor(), gatewayCapability)
  if (nativeModelOrigin) {
    await nativePrompt()
    process.stdout.write(
      'Personal DeepSeek adapter ran before login and after logout through a loopback model without restarting Host.\n',
    )
  }
  process.stdout.write(
    'Real server integration passed: inline native login, one local Home, product Python selection, single Host + Connector, file/terminal/chat, account change and logout without restart.\n',
  )
} catch (error) {
  process.stderr.write(diagnostics)
  throw error
} finally {
  await remote?.close()
  await connector?.stop()
  await gateway?.close()
  await host?.stop(true)
  await account?.close()
  cleanupDisposableTree(sandbox)
}
