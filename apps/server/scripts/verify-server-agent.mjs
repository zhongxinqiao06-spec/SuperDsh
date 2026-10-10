/** Real disposable PostgreSQL/API/Supervisor/Connector/Harness verification; no production account. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  randomBytes,
  randomUUID,
  createDecipheriv,
  createHash,
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`
const project = `superdsh-agent-verification-${stamp}`
const scratch = join(root, '.superdsh-work', project)
mkdirSync(scratch, { recursive: true })
const apiImage =
  process.env.SUPERDSH_VERIFY_API_IMAGE || 'superdsh-server:local'
const runtimeImage = 'superdsh-agent-runtime:local'
const supervisorImage = 'superdsh-agent-supervisor:local'
const sourceCompose = join(root, 'apps/server/docker/compose.yml')
const secrets = new Set()
const secret = () => {
  const value = randomBytes(32).toString('base64url')
  secrets.add(value)
  return value
}
const redact = (value) => {
  let result = String(value)
  for (const token of secrets) result = result.replaceAll(token, '<redacted>')
  return result
    .replace(/setup-token:\s*\S+/g, 'setup-token: <redacted>')
    .replace(/(?:Bearer|cxt_)\s*[A-Za-z0-9_.-]{20,}/g, '<redacted>')
}
const dockerEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(AGENT_SERVER_|SUPERDSH_MODEL_|SUPERDSH_AGENT_|SUPERDSH_SERVER_|SUPERDSH_PERSONAL_MODEL_|AGENTS_ANYWHERE_|POSTGRES_|DATABASE_URL$)/i.test(
        name,
      ),
  ),
)
async function run(
  command,
  args,
  { allowFailure = false, timeout = 120000 } = {},
) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      env: dockerEnvironment,
    })
    let output = '',
      errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code && !allowFailure)
        reject(
          new Error(redact(`${command} exited ${code}: ${errors || output}`)),
        )
      else resolveResult({ code, output, errors })
    })
  })
}
const docker = (...args) => run('docker', args)
async function until(probe, label, timeout = 120000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${redact(lastError.message)}` : ''}`,
  )
}
const port = await new Promise((resolvePort) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port
    server.close(() => resolvePort(value))
  })
})
const origin = `http://127.0.0.1:${port}`
const envFile = join(scratch, 'test.env')
writeFileSync(
  envFile,
  [
    `POSTGRES_PASSWORD=${secret()}`,
    `AGENT_SERVER_SECRET=${secret()}`,
    `SUPERDSH_MODEL_ENCRYPTION_KEY=${secret()}=`,
    `SUPERDSH_AGENT_SUPERVISOR_SECRET=${secret()}`,
    `AGENTS_ANYWHERE_WEB_PORT=${port}`,
    `AGENT_SERVER_PUBLIC_ORIGIN=${origin}`,
    `AGENT_SERVER_CORS_ORIGINS=${origin}`,
    'AGENT_SERVER_LOGIN_ALIAS=',
    'AGENT_SERVER_LOGIN_EMAIL=',
  ].join('\n'),
)
const override = join(scratch, 'compose.override.json')
writeFileSync(
  override,
  JSON.stringify({
    services: {
      'migrate-next': { image: apiImage },
      'server-next': {
        image: apiImage,
        environment: {
          SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS: 'http://model-fixture:8080',
        },
      },
      'agent-supervisor': {
        image: supervisorImage,
        environment: { SUPERDSH_SERVER_PROJECT: project },
      },
    },
  }),
)
const composeArgs = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '-f',
  sourceCompose,
  '-f',
  override,
]
const compose = (...args) => docker(...composeArgs, ...args)
const api = async (
  login,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
  expected = 200,
) => {
  const response = await fetch(origin + '/api/v2' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(login ? { authorization: `Bearer ${login.accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(40000),
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    value = { raw: text.slice(0, 200) }
  }
  assert(
    (Array.isArray(expected) ? expected : [expected]).includes(response.status),
    redact(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`),
  )
  return value
}
const evidence = {
  project,
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: [],
}
const check = (name) => {
  evidence.checks.push(name)
  process.stdout.write(`PASS ${name}\n`)
}
const fixtureContainer = `${project}-model-fixture`
const sockets = new Set()
let started = false
const existingStackState = async () => {
  const result = await run(
    'docker',
    [
      'inspect',
      '--format',
      '{{json .State}}',
      'superdsh-mobile-test-server-next-1',
    ],
    { allowFailure: true },
  )
  return result.code === 0 ? JSON.parse(result.output) : null
}
const realStackBefore = await existingStackState()
try {
  process.stdout.write(
    `Starting isolated verification ${project} on ${origin}\n`,
  )
  started = true
  await compose('up', '-d', '--no-build')
  await until(
    async () =>
      (await fetch(origin + '/api/v2/health/ready').catch(() => undefined))?.ok,
    'API readiness',
  )
  const config = await api(null, '/auth/config')
  assert.equal(config.needsBootstrap, true)
  const log = (await compose('logs', '--no-color', 'server-next')).output
  const setupToken = log.match(/setup-token:\s*([A-Za-z0-9_-]+)/)?.[1]
  assert(
    setupToken,
    'Temporary setup token must be emitted by this new API instance',
  )
  secrets.add(setupToken)
  const password = secret()
  const admin = await api(null, '/auth/register', {
    username: 'fixture_admin',
    displayName: 'Isolated administrator',
    password,
    setupToken,
    clientType: 'native',
    clientName: 'Isolated admin fixture',
  })
  secrets.add(admin.accessToken)
  secrets.add(admin.refreshToken)
  await api(admin, '/admin/settings', { registrationOpen: true }, 'PATCH')
  const owner = await api(null, '/auth/register', {
    username: 'fixture_owner',
    displayName: 'Isolated mobile owner',
    password,
    clientType: 'native',
    clientName: 'SuperDsh Android fixture',
  })
  secrets.add(owner.accessToken)
  secrets.add(owner.refreshToken)
  assert.notEqual(owner.userId, admin.userId)
  writeFileSync(
    join(scratch, 'test-accounts.json'),
    JSON.stringify({ origin, password, admin, owner }),
  )
  assert.deepEqual((await api(owner, '/connectors')).connectors, [])
  check(
    'empty database migration and two isolated accounts; zero desktop devices',
  )

  const version =
    JSON.parse(
      readFileSync(
        join(root, 'apps/desktop/plugins/harness/package.json'),
        'utf8',
      ),
    ).dependencies['@deepseek-ai/dsh'].match(/\d+\.\d+\.\d+-alpha\.\d+/)?.[0] ||
    '0.1.7-alpha.2'
  const fixtureDirectory = join(scratch, 'fixture')
  mkdirSync(fixtureDirectory)
  await run('tar', [
    '-xf',
    join(
      root,
      'vendor/dsh-runtime',
      version,
      `deepseek-ai-dsh-llm-mock-server-${version}.tgz`,
    ),
    '-C',
    fixtureDirectory,
    'package/lib/index.js',
  ])
  writeFileSync(
    join(fixtureDirectory, 'mock.mjs'),
    readFileSync(join(fixtureDirectory, 'package/lib/index.js')),
  )
  writeFileSync(
    join(fixtureDirectory, 'fixture.mjs'),
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        'server-agent-model-fixture.mjs',
      ),
    ),
  )
  await docker(
    'run',
    '-d',
    '--name',
    fixtureContainer,
    '--label',
    `com.superdsh.validation=${project}`,
    '--network',
    `${project}_default`,
    '--network-alias',
    'model-fixture',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    '/data:rw,nosuid,nodev,noexec,size=16777216',
    '--tmpfs',
    '/workspace:rw,nosuid,nodev,noexec,size=16777216',
    '--entrypoint',
    'node',
    '--mount',
    `type=bind,source=${fixtureDirectory},target=/fixture,readonly`,
    runtimeImage,
    '/fixture/fixture.mjs',
  )
  const fixtureRequest = async (path, body) => {
    const code = `fetch('http://127.0.0.1:8080${path}',${JSON.stringify(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})}).then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))`
    return JSON.parse(
      (await docker('exec', fixtureContainer, 'node', '-e', code)).output,
    )
  }
  await until(
    async () => await fixtureRequest('/stats'),
    'test model fixture readiness',
  )
  const fixtureKey = secret()
  const provider = await api(owner, '/models/personal/providers', {
    name: 'Disposable local model fixture',
    protocol: 'anthropic-messages',
    baseUrl: 'http://model-fixture:8080',
    apiKey: fixtureKey,
    models: [
      {
        modelId: 'fixture-model',
        name: 'Local real Host fixture',
        contextWindow: 32768,
        maxTokens: 2048,
      },
    ],
  })
  assert.equal(provider.apiKeyConfigured, true)
  assert.equal(provider.source, 'personal')
  assert(!JSON.stringify(provider).includes(fixtureKey))
  assert(/^[A-Za-z0-9_-]+$/.test(provider.providerId))
  const ciphertext = (
    await docker(
      'exec',
      `${project}-postgres-next-1`,
      'psql',
      '-U',
      'agents_anywhere',
      '-d',
      'agents_anywhere',
      '-Atc',
      `SELECT key_ciphertext FROM platform_model_providers WHERE id='${provider.providerId}'`,
    )
  ).output.trim()
  assert(ciphertext && !ciphertext.includes(fixtureKey))
  const encodedKey = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('SUPERDSH_MODEL_ENCRYPTION_KEY='))
    .split('=')[1]
  const encrypted = Buffer.from(ciphertext, 'base64url')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encodedKey, 'base64url'),
    encrypted.subarray(0, 12),
  )
  decipher.setAAD(
    Buffer.from(`personal:${owner.userId}:${provider.providerId}`),
  )
  decipher.setAuthTag(encrypted.subarray(-16))
  assert.equal(
    Buffer.concat([
      decipher.update(encrypted.subarray(12, -16)),
      decipher.final(),
    ]).toString(),
    fixtureKey,
  )
  await api(
    owner,
    '/models/personal/default',
    {
      selection: { providerId: provider.providerId, modelId: 'fixture-model' },
    },
    'PUT',
  )
  await api(
    owner,
    `/models/personal/providers/${provider.providerId}/verify`,
    {},
  )
  assert.deepEqual(
    (await api(admin, '/models/personal/providers')).providers,
    [],
  )
  await api(
    admin,
    `/models/personal/providers/${provider.providerId}`,
    undefined,
    'DELETE',
    404,
  )
  check(
    'personal provider encrypted and write-only; personal defaults; other account and administrator denied',
  )

  const prepared = await Promise.all(
    Array.from({ length: 3 }, () =>
      api(owner, '/server-agent', {}, 'POST', [200, 202]),
    ),
  )
  assert.equal(
    new Set(prepared.map((value) => value.agent.connectorId)).size,
    1,
  )
  const agent = await until(
    async () => {
      const value = (await api(owner, '/server-agent')).agent
      if (value.status === 'error') throw new Error(value.error)
      return value.status === 'running' ? value : false
    },
    'real server Agent readiness',
    150000,
  )
  assert.equal(agent.runtimeId, 'dsh')
  const desktop = (await api(owner, '/connectors')).connectors
  assert.equal(desktop.length, 1)
  assert.equal(desktop[0].executorKind, 'server-agent')
  assert.equal(desktop[0].status, 'online')
  const workers = (
    await docker(
      'ps',
      '-a',
      '--filter',
      `label=com.superdsh.project=${project}`,
      '--filter',
      'label=com.superdsh.managed-agent=true',
      '--format',
      '{{.ID}}',
    )
  ).output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  assert.equal(workers.length, 1)
  const ownerWorker = workers[0]
  const inspected = JSON.parse((await docker('inspect', ownerWorker)).output)[0]
  assert.equal(inspected.Config.User, '1000:1000')
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL'])
  assert(inspected.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  assert(inspected.HostConfig.Tmpfs['/tmp'].split(',').includes('noexec'))
  assert.equal(inspected.HostConfig.PidsLimit, 256)
  assert.equal(inspected.HostConfig.Memory, 2 * 1024 ** 3)
  assert.equal(inspected.HostConfig.NanoCpus, 2_000_000_000)
  assert.equal(inspected.Mounts.length, 2)
  assert(
    inspected.Mounts.every(
      (mount) =>
        mount.Type === 'volume' &&
        ['/data', '/workspace'].includes(mount.Destination),
    ),
  )
  assert(!inspected.Config.Env.some((item) => item.includes(fixtureKey)))
  assert(
    !inspected.Config.Env.some((item) =>
      /POSTGRES|ENCRYPTION_KEY|SUPERVISOR_SECRET|DB_URL/.test(item),
    ),
  )
  const networks = Object.keys(inspected.NetworkSettings.Networks)
  assert.equal(networks.length, 1)
  const network = JSON.parse(
    (await docker('network', 'inspect', networks[0])).output,
  )[0]
  assert.equal(Object.keys(network.Containers).length, 2)
  check(
    'actual Node Host and Connector ready; repeated prepare creates one worker; private volumes and API-only network',
  )
  const runtime = await api(owner, `/connectors/${agent.connectorId}/runtimes`)
  assert.equal(runtime.runtimes.length, 1)
  assert.equal(runtime.runtimes[0].runtimeId, 'dsh')
  assert.equal(runtime.runtimes[0].active, true)
  for (const operation of [
    {
      path: `/connectors/${agent.connectorId}/runtimes`,
      method: 'POST',
      body: {
        runtimeType: 'dsh',
        name: 'Unauthorized second runtime',
        config: {},
      },
    },
    {
      path: `/connectors/${agent.connectorId}/runtimes/dsh`,
      method: 'PATCH',
      body: { name: 'Unauthorized rename' },
    },
    {
      path: `/connectors/${agent.connectorId}/runtimes/dsh/config`,
      method: 'PUT',
      body: { config: { dshHome: '/another-user' } },
    },
    {
      path: `/connectors/${agent.connectorId}/runtimes/dsh/active`,
      method: 'PUT',
      body: { active: false },
    },
    {
      path: `/connectors/${agent.connectorId}/runtimes/dsh/config`,
      method: 'DELETE',
    },
  ])
    await api(owner, operation.path, operation.body, operation.method, 409)
  check(
    'managed DSH runtime cannot be renamed, replaced, deactivated or reconfigured by public client',
  )
  writeFileSync(
    join(scratch, 'runtime-catalog.json'),
    JSON.stringify(runtime, null, 2),
  )
  const catalog = await api(
    owner,
    `/connectors/${agent.connectorId}/runtimes/dsh/catalogs/model`,
  )
  const permission = await api(
    owner,
    `/connectors/${agent.connectorId}/runtimes/dsh/catalogs/permission`,
  )
  writeFileSync(
    join(scratch, 'catalog.json'),
    JSON.stringify({ catalog, permission }, null, 2),
  )
  if (process.argv.includes('--readiness-only')) {
    check('runtime catalog obtained from real DSH Runtime')
  } else {
    const model = catalog.catalog.models.find(
      (item) => item.metadata?.model === 'fixture-model',
    )
    const preset = permission.catalog.permissions.find(
      (item) => item.metadata?.preset === 'workspace-write',
    )
    assert(
      model && preset,
      'Owned model and workspace permissions must appear in actual DSH catalog',
    )
    const selections = {
      model: model.selectionId ?? model.id,
      permission: preset.selectionId,
    }
    const login = async (name, clientType = 'native') => {
      const value = await api(null, '/auth/login', {
        identifier: 'fixture_owner',
        password,
        clientType,
        clientName: name,
      })
      secrets.add(value.accessToken)
      if (value.refreshToken) secrets.add(value.refreshToken)
      return value
    }
    const web = await login('Management browser fixture', 'web')
    const computer = await login('SuperDsh desktop fixture')
    const connect = async (account, sessionId) => {
      const ticket = await api(account, '/ws-ticket', {
        clientId: randomUUID(),
        scope: { sessionId },
      })
      secrets.add(ticket.ticket)
      const socket = new WebSocket(
        origin.replace('http:', 'ws:') +
          `/api/v2/sessions/${sessionId}/ws?ticket=${ticket.ticket}`,
      )
      sockets.add(socket)
      const events = []
      socket.addEventListener('message', (event) =>
        events.push(JSON.parse(event.data)),
      )
      await new Promise((resolveOpen, reject) => {
        socket.addEventListener('open', resolveOpen, { once: true })
        socket.addEventListener('error', reject, { once: true })
      })
      await until(
        () => events.some((event) => event.type === 'session.subscribed'),
        'ticketed session subscription',
        15000,
      )
      return { socket, events }
    }
    const snapshot = (account, id) => api(account, `/sessions/${id}/snapshot`)
    const completed = async (account, id) =>
      until(
        async () => {
          const value = await snapshot(account, id)
          assert(
            !['error', 'blocked'].includes(value.state?.status),
            JSON.stringify(value.state),
          )
          return value.state?.status === 'idle' &&
            value.timeline.items.some(
              (item) =>
                item.role === 'assistant' &&
                JSON.stringify(item.content).includes(
                  'SUPERDSH_SERVER_AGENT_REAL_HOST_OK',
                ),
            )
            ? value
            : false
        },
        'durable real Host response',
        60000,
      )
    const create = async (account, content, extra = {}) => {
      const result = await api(account, '/sessions/create-and-start', {
        connectorId: agent.connectorId,
        projectId: agent.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        cwd: '/workspace',
        content,
        selections,
        clientMessageId: randomUUID(),
        ...extra,
      })
      assert.notEqual(
        result.connectorResult?.ok,
        false,
        JSON.stringify(result.connectorResult),
      )
      assert.equal(result.session.executorKind, 'server-agent')
      return result.session
    }
    await fixtureRequest('/control', {
      behavior: 'slow_success',
      chunkDelayMs: 180,
      count: 1,
    })
    const chat = await create(
      owner,
      'Stream through the real isolated Server Agent.',
    )
    let live = await connect(web, chat.id)
    await until(
      async () =>
        (await fixtureRequest('/stats')).calls.some(
          (item) => item.behavior === 'slow_success' && !item.finished,
        ),
      'actual in-flight model stream',
      15000,
    )
    await api(
      owner,
      '/auth/logout',
      { refreshToken: owner.refreshToken },
      'POST',
      204,
    )
    await api(owner, '/auth/me', undefined, 'GET', 401)
    const result = await completed(web, chat.id)
    check(
      'Anthropic Messages streamed through real Host, Connector and authenticated model proxy',
    )
    const desktopHistory = await snapshot(computer, chat.id)
    assert.deepEqual(desktopHistory.timeline.items, result.timeline.items)
    assert(
      live.events.some((event) => event.type !== 'session.subscribed'),
      'Actual API session WebSocket must receive live events',
    )
    live.socket.close()
    sockets.delete(live.socket)
    const mobile = await login('SuperDsh Android reconnected fixture')
    live = await connect(mobile, chat.id)
    const beforeReconnect = (await fixtureRequest('/stats')).calls.length
    await snapshot(mobile, chat.id)
    await delay(700)
    assert.equal((await fixtureRequest('/stats')).calls.length, beforeReconnect)
    assert.deepEqual(
      (await snapshot(mobile, chat.id)).timeline.items,
      result.timeline.items,
    )
    live.socket.close()
    sockets.delete(live.socket)
    check(
      'real streamed chat survives native client logout; web and desktop login tokens see identical history; reconnect does not generate again',
    )

    for (const protocol of ['openai-completions', 'openai-responses']) {
      const nextProvider = await api(mobile, '/models/personal/providers', {
        name: `Disposable ${protocol}`,
        protocol,
        baseUrl: 'http://model-fixture:8080',
        apiKey: fixtureKey,
        models: [
          {
            modelId: 'fixture-model',
            name: `Real ${protocol} fixture`,
            contextWindow: 32768,
            maxTokens: 2048,
          },
        ],
      })
      const refreshed = await until(
        async () => {
          const value = await api(
            mobile,
            `/connectors/${agent.connectorId}/runtimes/dsh/catalogs/model`,
          )
          return value.catalog.models.find((item) =>
            item.metadata?.provider?.endsWith(nextProvider.providerId),
          )
        },
        `${protocol} model registration without Host restart`,
        45000,
      )
      await fixtureRequest('/control', {
        behavior: 'slow_success',
        chunkDelayMs: 35,
        count: 1,
      })
      const nextChat = await create(
        mobile,
        `Stream using ${protocol} through the same real Host.`,
        {
          selections: {
            ...selections,
            model: refreshed.selectionId ?? refreshed.id,
          },
        },
      )
      await completed(mobile, nextChat.id)
      assert(
        (await fixtureRequest('/stats')).calls.some(
          (item) => item.protocol === protocol && item.finished,
        ),
      )
      check(
        `${protocol} streamed through real Host, Connector and authenticated model proxy`,
      )
    }

    const attachmentBytes = Buffer.from('SUPERDSH_TEMP_ATTACHMENT_PROOF')
    const attachment = {
      fileId: randomUUID(),
      name: 'attachment-proof.txt',
      mediaType: 'text/plain',
      size: attachmentBytes.length,
      sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
      contentBase64: attachmentBytes.toString('base64'),
    }
    const attachedSession = await create(
      mobile,
      'Read the test attachment and reply.',
      { attachments: [attachment] },
    )
    const attachedTimeline = await completed(mobile, attachedSession.id)
    const projectedAttachment = attachedTimeline.timeline.items
      .flatMap((item) => item.content?.attachments ?? [])
      .find((item) => item.sha256 === attachment.sha256)
    assert(
      projectedAttachment,
      'Real Connector projection must retain attachment metadata',
    )
    assert.equal(
      (
        await api(
          mobile,
          `/sessions/${attachedSession.id}/attachments/${projectedAttachment.fileId}`,
        )
      ).contentBase64,
      attachment.contentBase64,
    )
    await api(
      admin,
      `/sessions/${attachedSession.id}/attachments/${projectedAttachment.fileId}`,
      undefined,
      'GET',
      404,
    )
    await api(
      admin,
      `/sessions/${attachedSession.id}/attachments/${projectedAttachment.fileId}/open`,
      undefined,
      'GET',
      404,
    )
    check(
      'real Host attachment turn, durable attachment download and cross-account denial',
    )

    const filePath = '/workspace/account-marker.txt'
    await api(
      mobile,
      `/connectors/${agent.connectorId}/fs/write?root=/workspace`,
      { path: filePath, content: `owner:${owner.userId}` },
    )
    const file = await api(
      mobile,
      `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
      { path: filePath },
    )
    assert.equal(file.content, `owner:${owner.userId}`)
    for (const path of [
      `/sessions/${chat.id}/snapshot`,
      `/sessions/${chat.id}/timeline`,
      `/connectors/${agent.connectorId}`,
      `/connectors/${agent.connectorId}/terminals-v2`,
    ])
      await api(admin, path, undefined, 'GET', [403, 404])
    await api(
      admin,
      `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
      { path: filePath },
      'POST',
      [403, 404],
    )
    await api(
      admin,
      '/ws-ticket',
      { clientId: randomUUID(), scope: { sessionId: chat.id } },
      'POST',
      404,
    )
    const term = (
      await api(
        mobile,
        `/connectors/${agent.connectorId}/terminals-v2?root=/workspace`,
        { cwd: '/workspace', cols: 80, rows: 24 },
      )
    ).result
    assert(term.terminalId)
    await api(
      mobile,
      `/connectors/${agent.connectorId}/terminals-v2/${term.terminalId}/write`,
      {
        dataBase64: Buffer.from(
          'printf SUPERDSH_OWNED_TERMINAL_OK\\n\r',
        ).toString('base64'),
      },
    )
    await until(
      async () => {
        const value = (
          await api(
            mobile,
            `/connectors/${agent.connectorId}/terminals-v2/${term.terminalId}/snapshot`,
          )
        ).result
        return Buffer.from(value.dataBase64 ?? '', 'base64')
          .toString()
          .includes('SUPERDSH_OWNED_TERMINAL_OK')
      },
      'owned real terminal output',
      15000,
    )
    await api(
      admin,
      `/connectors/${agent.connectorId}/terminals-v2/${term.terminalId}/write`,
      { dataBase64: Buffer.from('id\r').toString('base64') },
      'POST',
      [403, 404],
    )
    await api(
      mobile,
      `/connectors/${agent.connectorId}/terminals-v2/${term.terminalId}`,
      undefined,
      'DELETE',
    )
    check(
      'real worker file and PTY operations; administrator denied session, ticket, files and terminal access',
    )

    const callsBeforeCancel = (await fixtureRequest('/stats')).calls.length
    await fixtureRequest('/control', {
      behavior: 'slow_success',
      chunkDelayMs: 500,
      count: 1,
    })
    const cancellable = await create(
      mobile,
      'Keep streaming until the real cancellation arrives.',
    )
    await until(
      async () =>
        (await fixtureRequest('/stats')).calls.some(
          (call) =>
            call.index >= callsBeforeCancel &&
            call.behavior === 'slow_success' &&
            !call.finished,
        ),
      'cancellable model stream',
      15000,
    )
    await api(computer, `/sessions/${cancellable.id}/runtime/interrupt`, {})
    await until(
      async () =>
        (await snapshot(mobile, cancellable.id)).state?.status === 'idle',
      'cancelled Host state',
      15000,
    )
    await until(
      async () =>
        (await fixtureRequest('/stats')).calls.some(
          (call) =>
            call.index >= callsBeforeCancel &&
            call.clientClosed &&
            !call.finished,
        ),
      'cancelled upstream model request',
      15000,
    )
    check(
      'real API cancellation reaches the server Host without stopping the worker',
    )

    await fixtureRequest('/control', {
      behavior: 'tool_call_success',
      count: 1,
      toolName: 'bash',
      toolArguments: {
        command: 'printf SUPERDSH_APPROVED_REAL_TOOL',
        description: 'Harmless approval verification',
        sandbox_permissions: 'danger-full-access',
        justification: 'Print isolated approval marker',
      },
    })
    const approvalChat = await create(
      mobile,
      'Run the harmless fixture command after approval.',
    )
    const notice = await until(
      async () =>
        (
          await api(mobile, `/sessions/${approvalChat.id}/runtime/notices`)
        ).notices.find(
          (item) => item.status === 'pending' || item.actions?.length,
        ),
      'real tool approval notice',
      20000,
    )
    const action = notice.actions.find((item) =>
      /allow|approv/.test(item.id || item.actionId),
    )
    assert(action, JSON.stringify(notice))
    const decision = { actionId: action.id ?? action.actionId }
    const approvalResponse = await api(
      computer,
      `/sessions/${approvalChat.id}/runtime/notices/${notice.noticeId}/respond`,
      decision,
    )
    assert.equal(approvalResponse.ok, true, JSON.stringify(approvalResponse))
    const repeatedApproval = await api(
      computer,
      `/sessions/${approvalChat.id}/runtime/notices/${notice.noticeId}/respond`,
      decision,
      'POST',
      [200, 409],
    )
    const repeatedOutcome =
      repeatedApproval.ok === true ? repeatedApproval.result : repeatedApproval
    if (Object.hasOwn(repeatedOutcome ?? {}, 'ok')) {
      assert.equal(
        repeatedOutcome.ok,
        false,
        'A repeated action cannot execute the tool again',
      )
      assert(
        [
          'not_found',
          'notice_not_found',
          'interaction_not_found',
          'request_not_found',
          'approval_not_found',
          'dsh_question_not_pending',
          'dsh_approval_not_pending',
        ].includes(repeatedOutcome.error?.code ?? repeatedOutcome.code),
        JSON.stringify(repeatedApproval),
      )
    }
    const approved = await completed(mobile, approvalChat.id)
    assert(
      JSON.stringify(approved.timeline.items).includes(
        'SUPERDSH_APPROVED_REAL_TOOL',
      ),
      'The actual shell output must be durably projected',
    )
    check('real tool approval through API v2 and harmless shell execution')

    await fixtureRequest('/control', {
      behavior: 'tool_call_success',
      count: 1,
      toolName: 'bash',
      toolArguments: {
        command: 'printf SUPERDSH_LATE_APPROVAL_MUST_NOT_EXECUTE',
        description: 'Late approval rejection check',
        sandbox_permissions: 'danger-full-access',
        justification: 'Print isolated late approval marker',
      },
    })
    const cancelledApproval = await create(
      mobile,
      'Wait for approval, then cancel this test turn.',
    )
    const pendingApproval = await until(
      async () =>
        (
          await api(mobile, `/sessions/${cancelledApproval.id}/runtime/notices`)
        ).notices.find((item) => item.actions?.length),
      'second real approval notice',
      20000,
    )
    const allowAction = pendingApproval.actions.find((item) =>
      /allow|approv/.test(item.id || item.actionId),
    )
    assert(allowAction)
    await api(
      computer,
      `/sessions/${cancelledApproval.id}/runtime/interrupt`,
      {},
    )
    await until(
      async () =>
        (await snapshot(mobile, cancelledApproval.id)).state.status === 'idle',
      'cancelled approval becomes idle',
      15000,
    )
    const lateApproval = await api(
      computer,
      `/sessions/${cancelledApproval.id}/runtime/notices/${pendingApproval.noticeId}/respond`,
      { actionId: allowAction.id ?? allowAction.actionId },
      'POST',
      [200, 400, 404, 409],
    )
    const lateOutcome =
      lateApproval.ok === true ? lateApproval.result : lateApproval
    if (Object.hasOwn(lateOutcome ?? {}, 'ok')) {
      assert.equal(
        lateOutcome.ok,
        false,
        'Expired approval must not acknowledge execution',
      )
      assert(
        [
          'not_found',
          'notice_not_found',
          'interaction_not_found',
          'request_not_found',
          'approval_not_found',
          'dsh_question_not_pending',
          'dsh_approval_not_pending',
        ].includes(lateOutcome.error?.code ?? lateOutcome.code),
        JSON.stringify(lateApproval),
      )
    }
    assert(
      !(await snapshot(mobile, cancelledApproval.id)).timeline.items.some(
        (item) =>
          item.content?.isError === false &&
          JSON.stringify(item.content?.output ?? item.content?.result).includes(
            'SUPERDSH_LATE_APPROVAL_MUST_NOT_EXECUTE',
          ),
      ),
    )
    check('late approval after cancellation cannot execute the tool')

    for (const scenario of [
      {
        name: 'subagent',
        args: {
          description: 'Isolated child proof',
          prompt: 'Reply with the fixture proof marker.',
          run_in_background: false,
        },
      },
      {
        name: 'workflow',
        args: {
          script:
            "const child = await agent('Reply with the fixture proof marker.'); return { child }",
          meta: {
            name: 'isolated-server-proof',
            description: 'Real workflow and child execution',
          },
        },
      },
    ]) {
      await fixtureRequest('/control', {
        behavior: 'tool_call_success',
        count: 1,
        toolName: scenario.name,
        toolArguments: scenario.args,
      })
      const session = await create(
        mobile,
        `Exercise real ${scenario.name} with the isolated test model.`,
      )
      const value = await completed(mobile, session.id)
      assert(
        value.timeline.items.some(
          (item) =>
            item.type === 'tool' &&
            item.content?.toolName === scenario.name &&
            item.content?.isError === false &&
            JSON.stringify(item.content).includes(
              'SUPERDSH_SERVER_AGENT_REAL_HOST_OK',
            ),
        ),
        `Actual successful ${scenario.name} result and child output must be projected`,
      )
      check(`real ${scenario.name} tool execution through the same server Host`)
    }

    await api(admin, '/server-agent', {}, 'POST', [200, 202])
    const secondAgent = await until(
      async () => {
        const value = (await api(admin, '/server-agent')).agent
        return value.status === 'running' ? value : false
      },
      'second isolated Agent ready',
      150000,
    )
    assert.notEqual(secondAgent.connectorId, agent.connectorId)
    await api(
      admin,
      `/connectors/${secondAgent.connectorId}/fs/write?root=/workspace`,
      { path: filePath, content: `admin:${admin.userId}` },
    )
    assert.equal(
      (
        await api(
          mobile,
          `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
          { path: filePath },
        )
      ).content,
      `owner:${owner.userId}`,
    )
    assert.equal(
      (
        await api(
          admin,
          `/connectors/${secondAgent.connectorId}/fs/readText?root=/workspace`,
          { path: filePath },
        )
      ).content,
      `admin:${admin.userId}`,
    )
    const allWorkers = (
      await docker(
        'ps',
        '-q',
        '--filter',
        `label=com.superdsh.project=${project}`,
        '--filter',
        'label=com.superdsh.managed-agent=true',
      )
    ).output
      .trim()
      .split(/\r?\n/)
    assert.equal(allWorkers.length, 2)
    const states = JSON.parse((await docker('inspect', ...allWorkers)).output)
    assert.equal(
      new Set(
        states.flatMap((state) => state.Mounts.map((mount) => mount.Name)),
      ).size,
      4,
    )
    assert.notEqual(
      states[0].HostConfig.NetworkMode,
      states[1].HostConfig.NetworkMode,
    )
    check(
      'two actual user containers have distinct Home/workspace volumes and private networks',
    )

    const callsBeforeRestart = (await fixtureRequest('/stats')).calls.length
    await docker('restart', ownerWorker)
    await until(
      async () =>
        (await api(mobile, '/server-agent')).agent.status === 'running',
      'restarted real Agent ready',
      120000,
    )
    assert.deepEqual(
      (await snapshot(mobile, chat.id)).timeline.items,
      result.timeline.items,
    )
    await delay(1500)
    assert.equal(
      (await fixtureRequest('/stats')).calls.length,
      callsBeforeRestart,
      'Worker restart cannot replay a completed inference',
    )
    assert.equal(
      (
        await api(
          mobile,
          `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
          { path: filePath },
        )
      ).content,
      `owner:${owner.userId}`,
    )
    check(
      'real worker restart preserves history and files without replaying completed generation',
    )

    const crashEffectPath = '/workspace/crash-effect-count.txt'
    const callsBeforeCrashScenario = (await fixtureRequest('/stats')).calls
      .length
    await fixtureRequest('/control', {
      behavior: 'tool_call_success',
      count: 1,
      toolName: 'bash',
      toolArguments: {
        command: `printf '1\\n' >> ${crashEffectPath}`,
        description: 'Count one isolated side effect',
      },
      chunkDelayMs: 10,
      followupChunkDelayMs: 1000,
    })
    const crashingSession = await create(
      mobile,
      'Execute one harmless counter write, then keep streaming until the simulated crash.',
    )
    await until(
      async () =>
        (
          await api(
            mobile,
            `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
            { path: crashEffectPath },
          )
        ).content === '1\n',
      'real side effect persisted before crash',
      20000,
    )
    await until(
      async () =>
        (await fixtureRequest('/stats')).calls.some(
          (call) =>
            call.index >= callsBeforeCrashScenario &&
            call.behavior === 'slow_success' &&
            !call.finished &&
            call.tools.length > 0,
        ),
      'actual follow-up generation in flight',
      15000,
    )
    const crashState = JSON.parse(
      (await docker('inspect', ownerWorker)).output,
    )[0].State
    await docker('kill', '--signal', 'KILL', ownerWorker)
    await until(
      async () => {
        const state = JSON.parse(
          (await docker('inspect', ownerWorker)).output,
        )[0].State
        return (
          state.StartedAt !== crashState.StartedAt &&
          state.Running &&
          state.Health?.Status === 'healthy' &&
          (await api(mobile, '/server-agent')).agent.status === 'running'
        )
      },
      'real crash recovery is healthy',
      120000,
    )
    await delay(3000)
    assert.equal(
      (
        await api(
          mobile,
          `/connectors/${agent.connectorId}/fs/readText?root=/workspace`,
          { path: crashEffectPath },
        )
      ).content,
      '1\n',
      'Crash recovery must not replay the completed side effect',
    )
    const recoveredCrash = await snapshot(mobile, crashingSession.id)
    assert(
      recoveredCrash.timeline.items.some(
        (item) => item.content?.toolName === 'bash',
      ),
      'Durable tool history must survive abrupt process exit',
    )
    check(
      'abrupt worker crash during follow-up stream preserves history and never replays the completed side effect',
    )
    await fixtureRequest('/control', { behavior: 'success' })

    await api(admin, `/admin/devices/${agent.connectorId}/block`, {
      reason: 'Isolated admission check',
    })
    await until(
      async () =>
        !JSON.parse((await docker('inspect', ownerWorker)).output)[0].State
          .Running,
      'blocked worker stopped by reconciler',
      30000,
    )
    await api(mobile, '/server-agent', {}, 'POST', 503)
    await delay(1500)
    assert.equal(
      JSON.parse((await docker('inspect', ownerWorker)).output)[0].State
        .Running,
      false,
    )
    check(
      'persistent connection block stops worker and rejects preparation without reconnect',
    )
    await api(admin, `/admin/devices/${agent.connectorId}/resume`, {})
    await api(mobile, '/server-agent', {}, 'POST', [200, 202])
    await until(
      async () =>
        (await api(mobile, '/server-agent')).agent.status === 'running',
      'resumed worker ready',
      120000,
    )

    const connectorToken = JSON.parse(
      (await docker('inspect', ownerWorker)).output,
    )[0]
      .Config.Env.find((value) =>
        value.startsWith('SUPERDSH_AGENT_CONNECTOR_TOKEN='),
      )
      .split('=')
      .slice(1)
      .join('=')
    secrets.add(connectorToken)
    const connectorLogin = await fetch(origin + '/api/v2/connector/auth', {
      method: 'POST',
      headers: {
        Authorization: `Connector ${agent.connectorId}:${connectorToken}`,
      },
    })
    assert.equal(connectorLogin.status, 200)
    const connectorAccess = await connectorLogin.json()
    secrets.add(connectorAccess.accessToken)
    const restrictedRole = await api(
      admin,
      '/admin/roles',
      {
        name: 'Isolated revoked execution',
        permissions: mobile.permissions.filter(
          (permission) => !['sessions.run', 'models.use'].includes(permission),
        ),
      },
      'POST',
      201,
    )
    await api(
      admin,
      `/admin/users/${owner.userId}`,
      { roles: [restrictedRole.id] },
      'PATCH',
    )
    await api(
      { accessToken: connectorAccess.accessToken },
      '/connector/models/catalog',
      undefined,
      'GET',
      [401, 403],
    )
    await api(
      mobile,
      `/sessions/${chat.id}/runtime/messages`,
      {
        content: 'Must not execute after revocation',
        clientMessageId: randomUUID(),
      },
      'POST',
      [401, 403],
    )
    await until(
      async () =>
        !JSON.parse((await docker('inspect', ownerWorker)).output)[0].State
          .Running,
      'revoked permissions stop actual worker',
      30000,
    )
    check(
      'execution permission revocation rejects existing Connector token immediately and stops the worker',
    )
    await api(
      admin,
      `/admin/users/${owner.userId}`,
      { roles: owner.roles },
      'PATCH',
    )
    const restoredLogin = await login('Restored permission fixture')
    await api(restoredLogin, '/server-agent', {}, 'POST', [200, 202])
    await until(
      async () =>
        (await api(restoredLogin, '/server-agent')).agent.status === 'running',
      'restored execution permissions ready',
      120000,
    )
    await api(
      admin,
      `/admin/users/${owner.userId}`,
      { disabled: true },
      'PATCH',
    )
    await api(mobile, '/auth/me', undefined, 'GET', 401)
    await until(
      async () =>
        !JSON.parse((await docker('inspect', ownerWorker)).output)[0].State
          .Running,
      'disabled account worker stopped',
      30000,
    )
    check('account disable invalidates old token and stops its actual worker')
    evidence.limitations.push(
      'API client modes are real logins; physical phone/Electron interface and Android cached drafts are covered separately, not by this server integration.',
    )
  }
} catch (error) {
  evidence.failure = redact(error.stack || error.message)
  const logs = await compose('logs', '--no-color').catch(() => ({ output: '' }))
  writeFileSync(join(scratch, 'compose.log'), redact(logs.output))
  const ids = (
    await docker(
      'ps',
      '-a',
      '--filter',
      `label=com.superdsh.project=${project}`,
      '--format',
      '{{.ID}}',
    ).catch(() => ({ output: '' }))
  ).output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  for (const id of ids) {
    const log = await docker('logs', '--tail', '250', id).catch((error) => ({
      output: error.message,
    }))
    writeFileSync(
      join(scratch, `${id}.log`),
      redact(log.output + (log.errors || '')),
    )
  }
  process.stderr.write(evidence.failure + '\n')
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  if (!process.argv.includes('--keep-failed') || !process.exitCode) {
    // Stop reconciliation before removing workers so cleanup cannot provision
    // a replacement container between inspection and removal.
    if (started) await compose('stop', 'server-next', 'agent-supervisor')
    const ids = (
      await docker(
        'ps',
        '-aq',
        '--filter',
        `label=com.superdsh.project=${project}`,
        '--filter',
        'label=com.superdsh.managed-agent=true',
      ).catch(() => ({ output: '' }))
    ).output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
    if (ids.length) await docker('rm', '-f', ...ids)
    await run('docker', ['rm', '-f', '-v', fixtureContainer], {
      allowFailure: true,
    })
    if (started) await compose('down', '--volumes', '--remove-orphans')
    for (const resource of ['network', 'volume']) {
      const names = (
        await docker(
          resource,
          'ls',
          '-q',
          '--filter',
          `label=com.superdsh.project=${project}`,
        )
      ).output
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
      if (names.length) await docker(resource, 'rm', ...names)
    }
    rmSync(envFile, { force: true })
    rmSync(join(scratch, 'test-accounts.json'), { force: true })
    for (const label of [
      `com.superdsh.project=${project}`,
      `com.docker.compose.project=${project}`,
    ]) {
      assert.equal(
        (await docker('ps', '-aq', '--filter', `label=${label}`)).output.trim(),
        '',
        'Disposable containers must be removed',
      )
      for (const kind of ['network', 'volume']) {
        assert.equal(
          (
            await docker(kind, 'ls', '-q', '--filter', `label=${label}`)
          ).output.trim(),
          '',
          'Disposable resources must be removed',
        )
      }
    }
    evidence.cleanedUp = true
  }
  if (realStackBefore) {
    const realStateAfter = await existingStackState()
    assert.equal(realStateAfter?.StartedAt, realStackBefore.StartedAt)
    assert.equal(realStateAfter?.Running, realStackBefore.Running)
    evidence.productionStackUnchanged = true
  }
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(
    join(scratch, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  process.stdout.write(`Evidence: ${join(scratch, 'evidence.json')}\n`)
}
