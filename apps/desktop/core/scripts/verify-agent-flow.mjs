/** Real shipped Host + pinned loopback Messages fixture. No account or external model is used. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { cleanupDisposableTree } from '../lib/backend/disposable-tree.js'
import { desktopRuntimeAssets } from '../lib/main/installation.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const desktop = realpathSync(join(root, 'apps/desktop'))
const require = createRequire(join(desktop, 'package.json'))
const harnessRequire = createRequire(
  require.resolve('@superdsh/harness/package.json'),
)
const { DesktopHostProcess } = await import(
  pathToFileURL(require.resolve('@superdsh/core/backend/host-process'))
)
const { NextProfiles } = await import(
  pathToFileURL(require.resolve('@superdsh/core/backend/profiles'))
)
const { authenticateWebHost } = await import(
  pathToFileURL(require.resolve('@superdsh/core/backend/web-auth'))
)
const { default: WebSocket } = await import(
  pathToFileURL(harnessRequire.resolve('ws'))
)
const tar = harnessRequire('tar')
const version = JSON.parse(
  readFileSync(harnessRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
).version
const home = mkdtempSync(join(tmpdir(), 'superdsh-agent-flow-'))
// Keep default workspaces and provider home lookups inside this disposable test home.
process.env.HOME = home
process.env.USERPROFILE = home
const sockets = new Set()
let fixture, host
try {
  const fixtureRoot = join(home, 'fixture')
  mkdirSync(fixtureRoot)
  // Reuse the dependency-free compiled upstream fixture from the already pinned vendor archive.
  await tar.x({
    file: join(
      root,
      'vendor/dsh-runtime',
      version,
      `deepseek-ai-dsh-llm-mock-server-${version}.tgz`,
    ),
    cwd: fixtureRoot,
    strict: true,
    filter: (path) =>
      ['package/package.json', 'package/lib/index.js'].includes(path),
  })
  const { startMockLlmServer } = await import(
    pathToFileURL(join(fixtureRoot, 'package/lib/index.js'))
  )
  fixture = await startMockLlmServer({
    sequence: [
      'slow_success',
      'slow_success',
      'tool_call_success',
      'success',
      'tool_call_success',
    ],
    successText:
      'Local fixture streamed through the real SuperDsh agent and persisted once.',
    chunkSize: 2,
    chunkDelayMs: 40,
    toolName: process.platform === 'win32' ? 'pwsh' : 'bash',
    toolArguments: JSON.stringify({
      command:
        process.platform === 'win32'
          ? 'Write-Output superdsh-approved-fixture'
          : 'printf superdsh-approved-fixture',
      description: 'Print the local approval fixture marker',
      sandbox_permissions: 'danger-full-access',
      justification:
        'Verify the local approval protocol with a harmless output command.',
    }),
  })
  const profiles = new NextProfiles(home)
  const profile = profiles.ensure('desktop')
  profiles.setFeatures('desktop', { market: false, remoteControl: false })
  writeFileSync(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      { id: 'session-title-llm', disabled: true },
      { id: 'llm-pi-ai', disabled: true },
      {
        id: 'llm-deepseek',
        config: {
          baseURL: fixture.baseURL,
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
      { id: 'approval', config: { policy: 'ask' } },
    ]),
  )
  const nativeToken = randomBytes(32).toString('base64url')
  host = new DesktopHostProcess(
    process.execPath,
    desktop,
    profile,
    undefined,
    {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      SUPERDSH_FIXTURE_KEY: 'local-fixture-only',
      DEEPSEEK_API_KEY: 'local-fixture-only',
      DEEPSEEK_BASE_URL: fixture.baseURL,
      DSH_PERMISSION_MODE: 'read-only',
      SUPERDSH_CLIENT_MANIFEST: desktopRuntimeAssets(
        join(desktop, 'package.json'),
      ).frontendManifest,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_NEXT_NATIVE_TOKEN: nativeToken,
      DSH_NEXT_PREFERENCES: JSON.stringify({ browserAccess: true }),
      DSH_NEXT_TRUSTED_HOSTS: '[]',
    },
    undefined,
    undefined,
    undefined,
    require.resolve('@superdsh/core/backend/host'),
  )
  let origin, cookie

  async function until(probe, label, timeout = 15_000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = await probe()
      if (value) return value
      await delay(20)
    }
    throw new Error(`Timed out: ${label}`)
  }
  async function rpc(method, args = {}, raw = false) {
    const rpcId = randomUUID()
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
      signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.status, 200, method)
    const result = await response.json()
    assert.equal(result.rpcId, rpcId)
    if (raw) return result.result
    assert.equal(
      result.result.ok,
      true,
      `${method}: ${JSON.stringify(result.result)}`,
    )
    return result.result.value
  }
  async function connect(endpoint, args = {}) {
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/api/remote.mux`,
      {
        headers: { cookie, origin, 'x-dsh-desktop-renderer': nativeToken },
        handshakeTimeout: 10_000,
      },
    )
    sockets.add(socket)
    const frames = [],
      errors = []
    socket.on('error', (error) => errors.push({ message: error.message }))
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'item') frames.push(message.value)
      else if (message.type === 'error') errors.push(message.error)
    })
    await once(socket, 'open')
    socket.send(
      JSON.stringify({
        type: 'open',
        streamId: 'flow',
        endpoint,
        payload: { args },
      }),
    )
    await until(() => {
      assert.deepEqual(errors, [])
      return frames.length > 0
    }, `${endpoint} opening frame`)
    return { socket, frames, errors }
  }
  async function disconnect(stream) {
    if (stream.socket.readyState === WebSocket.CLOSED) return
    const closed = once(stream.socket, 'close')
    stream.socket.terminate()
    await closed
    sockets.delete(stream.socket)
  }
  const follow = (sessionId) =>
    connect('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
      },
    })
  const events = (stream) =>
    stream.frames.flatMap((frame) =>
      frame.type === 'snapshot'
        ? frame.records.map((record) => record.event)
        : frame.type === 'event'
          ? [frame.event]
          : [],
    )
  const prompt = (sessionId) =>
    rpc('session/prompt', {
      request: {
        sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [
          { type: 'text', text: 'Run the local verification fixture.' },
        ],
      },
    })
  async function completed(stream, label) {
    return until(() => {
      assert.deepEqual(stream.errors, [])
      return events(stream).find((event) => event.type === 'turn/end')
    }, label)
  }
  let startupTimer
  const ready = await Promise.race([
    host.start(),
    new Promise((_, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error('Host startup exceeded 60 seconds')),
        60_000,
      )
    }),
  ]).finally(() => clearTimeout(startupTimer))
  origin = new URL(ready.url).origin
  cookie = await authenticateWebHost(ready.url, nativeToken)
  assert.equal(new URL(origin).hostname, '127.0.0.1')

  const first = (
    await rpc('session/create', {
      request: { sessionId: 'fixture-stream', cwd: profile },
    })
  ).sessionId
  let stream = await follow(first)
  await prompt(first)
  await until(
    () =>
      stream.frames.some(
        (frame) =>
          frame.type === 'assistant-stream' && frame.frame.type === 'chunk',
      ),
    'first live assistant chunk',
  )
  await disconnect(stream)
  stream = await follow(first)
  const opening = stream.frames[0]
  assert.equal(opening.type, 'snapshot')
  assert.ok(
    opening.assistantStream?.activeAttempt?.nextIndex > 0,
    'Reconnect must recover the in-flight assistant baseline',
  )
  assert.equal(
    (await completed(stream, 'stream completion after reconnect')).data.reason
      .kind,
    'completed',
  )
  const firstEvents = events(stream)
  assert.equal(
    firstEvents.filter(
      (event) =>
        event.type === 'user/message' && event.data.source.kind === 'user',
    ).length,
    1,
  )
  assert.equal(
    firstEvents.filter((event) => event.type === 'assistant/message').length,
    1,
  )
  const liveSeqs = stream.frames
    .filter((frame) => frame.type === 'event')
    .map((frame) => frame.event.seq)
  for (let i = 1; i < liveSeqs.length; i++)
    assert.equal(
      liveSeqs[i],
      liveSeqs[i - 1] + 1,
      'Durable events must remain contiguous',
    )
  assert.equal(
    fixture.requests.length,
    1,
    'Reconnect must not submit another model request',
  )
  await disconnect(stream)

  const cancelId = (
    await rpc('session/create', {
      request: { sessionId: 'fixture-cancel', cwd: profile },
    })
  ).sessionId
  stream = await follow(cancelId)
  await prompt(cancelId)
  await until(
    () =>
      stream.frames.some(
        (frame) =>
          frame.type === 'assistant-stream' && frame.frame.type === 'chunk',
      ),
    'cancellable local provider stream',
  )
  await rpc('session/cancel', { request: { sessionId: cancelId } })
  const cancelled = await completed(stream, 'cancelled turn')
  assert.equal(cancelled.data.reason.kind, 'aborted')
  await until(
    () => fixture.requests[1]?.outcome === 'client_closed',
    'provider socket aborted by cancellation',
  )
  assert.equal(cancelled.data.reason.reason.kind, 'user')
  assert.equal(
    events(stream).filter((event) => event.type === 'turn/end').length,
    1,
  )
  await disconnect(stream)

  const approvalId = (
    await rpc('session/create', {
      request: { sessionId: 'fixture-approval', cwd: profile },
    })
  ).sessionId
  let remote = await connect('$events')
  const oldClientId = remote.frames[0].clientId
  stream = await follow(approvalId)
  await prompt(approvalId)
  const question = await until(
    () =>
      remote.frames.find(
        (frame) =>
          frame.type === 'waterfall' && frame.event === 'approval/request',
      ),
    'real tool approval request',
  )
  await disconnect(remote)
  remote = await connect('$events')
  const clientId = remote.frames[0].clientId
  assert.notEqual(clientId, oldClientId)
  const restoredQuestion = await until(
    () =>
      remote.frames.find(
        (frame) =>
          frame.type === 'waterfall' && frame.event === 'approval/request',
      ),
    'pending approval redelivery after reconnect',
  )
  assert.equal(
    restoredQuestion.eventId,
    question.eventId,
    'Reconnection must retain the same pending approval identity',
  )
  assert.equal(
    (
      await rpc(
        '$events/result',
        {
          clientId: oldClientId,
          eventId: question.eventId,
          outcome: { kind: 'result', value: 'allowed-once' },
        },
        true,
      )
    ).ok,
    false,
    'Disconnected event generation loses answer authority',
  )
  const answer = {
    clientId,
    eventId: question.eventId,
    outcome: { kind: 'result', value: 'allowed-once' },
  }
  await rpc('$events/result', answer)
  const duplicate = await rpc('$events/result', answer, true)
  assert.equal(
    duplicate.ok,
    true,
    'The pinned Gateway intentionally acknowledges duplicate results as idempotent no-ops',
  )
  assert.equal(
    (await completed(stream, 'approved tool turn')).data.reason.kind,
    'completed',
  )
  const approvalEvents = events(stream)
  assert.equal(
    approvalEvents.filter((event) => event.type === 'approval/asked').length,
    1,
  )
  const decisions = approvalEvents.filter(
    (event) => event.type === 'approval/decided',
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].data.outcome, 'allowed-once')
  const toolResults = approvalEvents.filter(
    (event) => event.type === 'tool/result',
  )
  assert.equal(
    toolResults.length,
    1,
    JSON.stringify(approvalEvents.map((event) => event.type)),
  )
  assert.notEqual(
    toolResults[0].data.message.isError,
    true,
    JSON.stringify(toolResults[0]),
  )
  assert.ok(
    toolResults[0].data.message.content.some(
      (part) =>
        part.type === 'text' && part.text.includes('superdsh-approved-fixture'),
    ),
    `Actual harmless shell output must persist: ${JSON.stringify(toolResults[0])}`,
  )
  await disconnect(stream)

  const withdrawnId = (
    await rpc('session/create', {
      request: { sessionId: 'fixture-withdrawn', cwd: profile },
    })
  ).sessionId
  stream = await follow(withdrawnId)
  await prompt(withdrawnId)
  const withdrawn = await until(
    () =>
      remote.frames.find(
        (frame) =>
          frame.type === 'waterfall' &&
          frame.event === 'approval/request' &&
          frame.agentId === withdrawnId,
      ),
    'approval to withdraw',
  )
  await rpc('session/cancel', { request: { sessionId: withdrawnId } })
  assert.equal(
    (await completed(stream, 'withdrawn approval turn')).data.reason.kind,
    'aborted',
  )
  await rpc('$events/result', {
    clientId,
    eventId: withdrawn.eventId,
    outcome: { kind: 'result', value: 'allowed-once' },
  })
  const withdrawnDecisions = events(stream).filter(
    (event) => event.type === 'approval/decided',
  )
  assert.equal(withdrawnDecisions.length, 1)
  assert.equal(
    withdrawnDecisions[0].data.outcome,
    'cancelled',
    'A late answer cannot revive a cancelled approval',
  )
  const withdrawnResults = events(stream).filter(
    (event) => event.type === 'tool/result',
  )
  assert.ok(
    withdrawnResults.every((event) => event.data.message.isError === true),
    'Cancelled approval cannot produce successful tool output',
  )
  assert.deepEqual(
    fixture.requests.map((request) => request.behavior),
    [
      'slow_success',
      'slow_success',
      'tool_call_success',
      'success',
      'tool_call_success',
    ],
  )
  process.stdout.write(
    'SuperDsh real agent flow passed: incremental stream, in-flight reconnect without replaying prompt, cancellation aborts provider, pending approval reconnect, stale-client rejection, idempotent duplicate answer and cancelled-approval late-answer safety.\n',
  )
} finally {
  for (const socket of sockets) socket.terminate()
  const closing = await Promise.allSettled([host?.stop(true), fixture?.close()])
  cleanupDisposableTree(home)
  const failures = closing
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length) {
    // A cleanup failure must fail the contract even after its assertions succeeded.
    // eslint-disable-next-line no-unsafe-finally
    throw new AggregateError(failures, 'Agent-flow cleanup failed')
  }
}
