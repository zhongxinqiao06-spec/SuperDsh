/** Black-box contract for the fixed backend child and the real shipped Harness profile. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanupDisposableTree } from '../lib/backend/disposable-tree.js'
import { desktopRuntimeAssets } from '../lib/main/installation.js'

// Optional explicit artifact paths run this same contract against the packaged dependency tree.
const parameter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (!process.argv[index + 1]) throw new Error(`Missing ${name} value`)
  return resolve(process.argv[index + 1])
}
const desktop = realpathSync(
  parameter('--desktop-root') ??
    fileURLToPath(new URL('../../', import.meta.url)),
)
const executable = parameter('--executable') ?? process.execPath
const require = createRequire(join(desktop, 'package.json'))
const backend = dirname(require.resolve('@superdsh/core/package.json'))
const { DesktopHostProcess } = await import(
  pathToFileURL(join(backend, 'lib/backend/host-process.js'))
)
const { NextProfiles } = await import(
  pathToFileURL(join(backend, 'lib/backend/profiles.js'))
)
const { authenticateWebHost } = await import(
  pathToFileURL(join(backend, 'lib/backend/web-auth.js'))
)
const frontendManifest = desktopRuntimeAssets(
  join(desktop, 'package.json'),
).frontendManifest
const entry = require.resolve('@superdsh/core/backend/host')
const home = mkdtempSync(join(tmpdir(), 'superdsh-host-contract-'))
// Keep default workspaces and provider home lookups inside this disposable test home.
process.env.HOME = home
process.env.USERPROFILE = home
const manager = new NextProfiles(home)
const directory = manager.ensure('desktop')
manager.setFeatures('desktop', { market: false, remoteControl: false })
const nativeToken = randomBytes(32).toString('base64url')
let hostDiagnostics = ''
const createHost = () =>
  new DesktopHostProcess(
    executable,
    desktop,
    directory,
    undefined,
    {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      SUPERDSH_CLIENT_MANIFEST: frontendManifest,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_NEXT_NATIVE_TOKEN: nativeToken,
      DSH_NEXT_PREFERENCES: JSON.stringify({ browserAccess: true }),
      DSH_NEXT_TRUSTED_HOSTS: '[]',
    },
    undefined,
    undefined,
    undefined,
    entry,
    undefined,
    undefined,
    (chunk) => {
      hostDiagnostics = (hostDiagnostics + chunk).slice(-12_000)
    },
  )
let host = createHost()
let timer
try {
  const ready = await Promise.race([
    host.start(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error('SuperDsh Host contract startup exceeded 60 seconds'),
          ),
        60_000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  let origin = new URL(ready.url).origin
  assert.doesNotMatch(
    hostDiagnostics,
    /opening the default browser/,
    'The desktop-owned Host must honor headless startup',
  )
  assert.equal(new URL(origin).hostname, '127.0.0.1')
  assert.ok(Array.isArray(ready.injections) && ready.injections.length > 0)
  assert.ok((await host.collectInjections()).length > 0)
  let cookie = await authenticateWebHost(ready.url, nativeToken)
  const document = await fetch(origin, {
    headers: { cookie, 'x-dsh-desktop-renderer': nativeToken },
  })
  assert.equal(document.status, 200)
  assert.ok(
    (await document.text()).includes('<title>SuperDsh</title>'),
    'Ordinary browser requests must use the owned frontend document',
  )
  const compatibilityUrl = `${origin}/compatibility.html`
  const anonymousCompatibility = await fetch(compatibilityUrl)
  assert.equal(
    anonymousCompatibility.status,
    401,
    'The compatibility document requires Host authentication',
  )
  await anonymousCompatibility.body?.cancel()
  const compatibility = await fetch(compatibilityUrl, { headers: { cookie } })
  assert.equal(compatibility.status, 200)
  const compatibilityHtml = await compatibility.text()
  assert.ok(
    compatibilityHtml.includes('__DSH_BOOT_READY__'),
    'The compatibility document must receive the live Host index injections',
  )
  const compatibilityHead = await fetch(compatibilityUrl, {
    method: 'HEAD',
    headers: { cookie },
  })
  assert.equal(compatibilityHead.status, 200)
  assert.equal(await compatibilityHead.text(), '')
  assert.ok(Number(compatibilityHead.headers.get('content-length')) > 0)
  const rpc = async (method, args = {}, allowStarting = false) => {
    const rpcId = crypto.randomUUID()
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-dsh-desktop-renderer': nativeToken,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: { args },
      }),
    })
    const body = await response.text()
    if (allowStarting && response.status === 404)
      return { ok: false, starting: true }
    assert.equal(
      response.status,
      200,
      `${method} returned HTTP ${response.status}: ${body.slice(0, 250)}`,
    )
    const result = JSON.parse(body)
    assert.equal(result.rpcId, rpcId)
    return result.result
  }
  const bundles = await rpc('pluginManager/listBundles')
  assert.equal(bundles.ok, true, JSON.stringify(bundles))
  for (const name of [
    '@superdsh/harness',
    '@superdsh/desktop',
    '@agents-anywhere/dsh-bridge-next',
  ]) {
    assert.ok(
      bundles.value.some((bundle) => bundle.name === name),
      `Missing built-in bundle ${name}`,
    )
  }
  for (const name of [
    'dsh-community-market',
    'dshmarket',
    '@agents-anywhere/dsh-bridge-next',
  ]) {
    const optional = bundles.value.find((bundle) => bundle.name === name)
    assert.ok(optional, `Missing optional built-in bundle ${name}`)
    assert.equal(
      optional.optional,
      true,
      `${name} must retain its optional bundle metadata`,
    )
    assert.equal(
      optional.removable,
      false,
      `${name} is supplied by the installation`,
    )
    assert.equal(
      optional.readOnlyReason,
      undefined,
      `${name} must remain user-switchable`,
    )
  }
  for (const name of ['@superdsh/harness', '@superdsh/desktop']) {
    const required = bundles.value.find((bundle) => bundle.name === name)
    assert.equal(required.enabled, true, `${name} must remain enabled`)
    assert.equal(
      required.readOnlyReason,
      'management-required',
      `${name} must be protected by the runtime manager`,
    )
    assert.equal(required.removable, false)
    const disabled = await rpc('pluginManager/setBundleEnabled', {
      name,
      enabled: false,
    })
    assert.equal(disabled.ok, true, JSON.stringify(disabled))
    assert.equal(disabled.value.changed, false, JSON.stringify(disabled))
    assert.equal(disabled.value.application, 'failed', JSON.stringify(disabled))
    assert.equal(
      disabled.value.error?.code,
      'management-required',
      JSON.stringify(disabled),
    )
  }
  const requiredPlugins = await rpc('pluginManager/listPlugins')
  assert.equal(requiredPlugins.ok, true, JSON.stringify(requiredPlugins))
  const webserver = requiredPlugins.value.find(
    (plugin) => plugin.moduleName === '@superdsh/harness/webserver',
  )
  assert.ok(webserver, 'The local Host transport must be present')
  assert.equal(
    webserver.readOnlyReason,
    'management-required',
    'The local Host transport must not be switchable',
  )
  const serverDisabled = await rpc('pluginManager/setPluginEnabled', {
    id: webserver.entryId,
    enabled: false,
  })
  assert.equal(serverDisabled.ok, true, JSON.stringify(serverDisabled))
  assert.equal(
    serverDisabled.value.changed,
    false,
    JSON.stringify(serverDisabled),
  )
  assert.equal(
    serverDisabled.value.application,
    'failed',
    JSON.stringify(serverDisabled),
  )
  assert.equal(
    serverDisabled.value.error?.code,
    'management-required',
    JSON.stringify(serverDisabled),
  )
  const bridgeEnabled = await rpc('pluginManager/setBundleEnabled', {
    name: '@agents-anywhere/dsh-bridge-next',
    enabled: true,
  })
  assert.equal(bridgeEnabled.ok, true, JSON.stringify(bridgeEnabled))
  assert.equal(
    bridgeEnabled.value.application,
    'applied',
    JSON.stringify(bridgeEnabled),
  )
  let bridge
  for (let attempt = 0; attempt < 40; attempt++) {
    const plugins = await rpc('pluginManager/listPlugins')
    assert.equal(plugins.ok, true, JSON.stringify(plugins))
    bridge = plugins.value.find(
      (plugin) => plugin.moduleName === '@agents-anywhere/dsh-bridge-next',
    )
    if (bridge?.fiberPhase === 'active') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(
    bridge?.fiberPhase,
    'active',
    `The existing AA adapter must mount inside the extracted Harness runtime: ${JSON.stringify(bridge)}`,
  )
  // A Cordis parent row can become active before its asynchronous child Services publish.
  // Require the real endpoint and local bridge to become ready within a bounded interval.
  let onboarding
  for (let attempt = 0; attempt < 50; attempt++) {
    onboarding = await rpc('agentsAnywhereOnboarding/inspect', {}, true)
    if (onboarding.ok && onboarding.value.bridge.state === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(
    onboarding.ok,
    true,
    `AA onboarding must be callable after activation: ${JSON.stringify(onboarding)}`,
  )
  assert.equal(
    onboarding.value.bridge.state,
    'ready',
    `The local AA runtime must mount alongside onboarding: ${JSON.stringify(onboarding.value.bridge)}`,
  )
  const selection = await rpc('agentsAnywhereOnboarding/selection', {
    input: { clientId: 'superdsh-contract', revision: 1, current: null },
  })
  assert.equal(
    selection.ok,
    true,
    `AA selection presence must be callable: ${JSON.stringify(selection)}`,
  )
  assert.ok(
    (await host.collectInjections()).length > 0,
    'Plugin activation must preserve dynamic frontend injections',
  )
  const bridgeDisabled = await rpc('pluginManager/setBundleEnabled', {
    name: '@agents-anywhere/dsh-bridge-next',
    enabled: false,
  })
  assert.equal(bridgeDisabled.ok, true, JSON.stringify(bridgeDisabled))
  const created = await rpc('session/create', {
    request: { sessionId: 'superdsh-contract-session', cwd: directory },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.value.sessionId, 'superdsh-contract-session')
  const listed = await rpc('session/list', { _request: {} })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.ok(
    listed.value.items.some(
      (item) => item.sessionId === created.value.sessionId,
    ),
  )
  const renamed = await rpc('session/rename', {
    request: {
      sessionId: created.value.sessionId,
      title: 'Backend contract fixture',
    },
  })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  // Invalid input must reach the original controller validation without contacting a model provider.
  const rejected = await rpc('session/prompt', {
    request: {
      sessionId: created.value.sessionId,
      requestId: 'empty-contract-prompt',
      mode: 'queue',
      content: [],
    },
  })
  assert.equal(rejected.ok, false)
  await host.setBrowserAccess(false)
  const denied = await fetch(origin)
  assert.equal(denied.status, 403)
  await denied.body?.cancel()
  const deniedCompatibility = await fetch(compatibilityUrl, {
    headers: { cookie },
  })
  assert.equal(
    deniedCompatibility.status,
    403,
    'Disabling ordinary-browser access also revokes the compatibility document',
  )
  await deniedCompatibility.body?.cancel()
  assert.equal(
    (await rpc('session/list', { _request: {} })).ok,
    true,
    'Native authority must survive ordinary-browser revocation',
  )
  await host.setBrowserAccess(true)
  await host.stop(true)
  host = createHost()
  const restarted = await Promise.race([
    host.start(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error('SuperDsh Host contract restart exceeded 60 seconds'),
          ),
        60_000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  origin = new URL(restarted.url).origin
  assert.doesNotMatch(
    hostDiagnostics,
    /opening the default browser/,
    'A restarted Host must also remain headless',
  )
  cookie = await authenticateWebHost(restarted.url, nativeToken)
  const restored = await rpc('session/list', { _request: {} })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.ok(
    restored.value.items.some(
      (item) => item.sessionId === created.value.sessionId,
    ),
    'Session must survive backend replacement',
  )
  const page = await rpc('session/page', {
    request: {
      address: { kind: 'session', sessionId: created.value.sessionId },
      throughSeq: renamed.value.seq,
    },
  })
  assert.equal(page.ok, true, JSON.stringify(page))
  assert.ok(
    page.value.records.some((record) => record.event.seq === renamed.value.seq),
    'Committed rename must survive graceful shutdown and cold read',
  )
  await host.stop(true)
  assert.doesNotMatch(
    hostDiagnostics,
    /opening the default browser/,
    'The complete Host lifecycle must not request a graphical browser',
  )
  process.stdout.write(
    'SuperDsh backend Host contract passed: owned frontend document, protected required bundles and Host transport, switchable optional bundles, IPC, real profile, AA inspect/selection and bridge ready, session RPC, browser gate, persisted history and headless graceful restart.\n',
  )
} catch (error) {
  process.stderr.write(hostDiagnostics)
  throw error
} finally {
  clearTimeout(timer)
  await host.stop()
  cleanupDisposableTree(home)
}
