import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import {
  isLoopbackPortAvailable,
  planDevelopmentDependencies,
} from './server-dependencies.mjs'
import {
  developmentEnvironment,
  persistDevelopmentPorts,
  prepareDevelopmentEnv,
} from './server-development.mjs'

const defaultPorts = {
  SUPERDSH_DEV_PG_PORT: '15432',
  SUPERDSH_DEV_REDIS_PORT: '16379',
  SUPERDSH_DEV_QDRANT_PORT: '16333',
}

function container(service, options = {}) {
  const port =
    { postgres: '5432/tcp', redis: '6379/tcp', qdrant: '6333/tcp' }[service] ||
    '9999/tcp'
  const hostPort =
    { postgres: '15432', redis: '16379', qdrant: '16333' }[service] || '19999'
  return {
    Id: `container-${service}`,
    Config: {
      Labels: {
        'com.docker.compose.project': options.project || 'superdsh-dev',
        'com.docker.compose.service': service,
        'com.docker.compose.oneoff': 'False',
      },
    },
    State: {
      Running: true,
      Paused: false,
      Restarting: false,
      Health: { Status: 'healthy' },
      ...options.state,
    },
    NetworkSettings: {
      Ports: {
        [port]: [
          { HostIp: '127.0.0.1', HostPort: options.hostPort || hostPort },
        ],
      },
    },
  }
}

function temporaryRepository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'superdsh-deps-')))
  t.after(() => {
    assert.ok(root.startsWith(`${realpathSync(tmpdir())}${sep}`))
    assert.ok(root.includes('superdsh-deps-'))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('healthy managed dependencies are reused without probing or restarting their ports', async () => {
  const result = await planDevelopmentDependencies(
    [container('postgres'), container('redis'), container('qdrant')],
    defaultPorts,
    {
      portAvailable: async () => {
        assert.fail('A healthy dependency already owns its port')
      },
    },
  )
  assert.deepEqual(result.ports, defaultPorts)
  assert.deepEqual(result.ready.sort(), ['postgres', 'qdrant', 'redis'])
  assert.deepEqual(result.start, [])
  assert.deepEqual(result.wait, [])
})

test('a healthy dependency keeps its actual port while only a missing service starts', async () => {
  const probed = []
  const result = await planDevelopmentDependencies(
    [container('postgres', { hostPort: '25432' }), container('qdrant')],
    defaultPorts,
    {
      portAvailable: async (port) => {
        probed.push(port)
        return true
      },
    },
  )
  assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '25432')
  assert.equal(result.ports.SUPERDSH_DEV_REDIS_PORT, '16379')
  assert.deepEqual(result.ready, ['postgres', 'qdrant'])
  assert.deepEqual(result.start, ['redis'])
  assert.deepEqual(result.wait, [])
  assert.deepEqual(probed, ['16379'])
})

test('unrelated containers are never adopted and occupied ports receive independent alternatives', async () => {
  const result = await planDevelopmentDependencies(
    [
      container('postgres', { project: 'predict-prototype' }),
      container('redis', { project: 'predict-prototype' }),
      container('qdrant', { project: 'predict-prototype' }),
    ],
    defaultPorts,
    {
      portAvailable: async (port) =>
        !['15432', '16379', '16333'].includes(port),
    },
  )
  assert.deepEqual(result.ready, [])
  assert.deepEqual(result.start.sort(), ['postgres', 'qdrant', 'redis'])
  assert.deepEqual(result.wait, [])
  assert.deepEqual(result.ports, {
    SUPERDSH_DEV_PG_PORT: '15433',
    SUPERDSH_DEV_REDIS_PORT: '16380',
    SUPERDSH_DEV_QDRANT_PORT: '16334',
  })
})

test('starting managed dependencies are waited for without creating replacement containers', async () => {
  for (const health of [{ Status: 'starting' }, undefined]) {
    const result = await planDevelopmentDependencies(
      [
        container('postgres', {
          hostPort: '25432',
          state: { Health: health },
        }),
        container('redis'),
        container('qdrant'),
      ],
      defaultPorts,
      {
        portAvailable: async () =>
          assert.fail('Do not rebind running services'),
      },
    )
    assert.deepEqual(result.wait, ['postgres'])
    assert.deepEqual(result.ready, ['redis', 'qdrant'])
    assert.deepEqual(result.start, [])
    assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '25432')
  }
})

test('unhealthy, paused and restarting managed containers require diagnosis rather than silent reuse', async () => {
  for (const state of [
    { Health: { Status: 'unhealthy' } },
    { Paused: true },
    { Restarting: true },
    { Running: false, Restarting: true },
  ]) {
    await assert.rejects(
      planDevelopmentDependencies(
        [container('postgres', { state }), container('redis')],
        defaultPorts,
        { portAvailable: async () => true },
      ),
    )
  }
})

test('stopped containers are started using an available configured port, not stale bindings', async () => {
  const result = await planDevelopmentDependencies(
    [
      container('postgres', {
        hostPort: '25432',
        state: { Running: false, Health: undefined },
      }),
      container('redis'),
      container('qdrant'),
    ],
    defaultPorts,
    { portAvailable: async () => true },
  )
  assert.deepEqual(result.start, ['postgres'])
  assert.deepEqual(result.ready, ['redis', 'qdrant'])
  assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '15432')
})

test('duplicate managed services are rejected instead of choosing an arbitrary database', async () => {
  await assert.rejects(
    planDevelopmentDependencies(
      [container('postgres'), container('postgres', { hostPort: '25432' })],
      defaultPorts,
      { portAvailable: async () => true },
    ),
  )
})

test('one-off compose tasks and unrelated services do not replace managed dependencies', async () => {
  const oneoff = container('postgres', { hostPort: '25432' })
  oneoff.Config.Labels['com.docker.compose.oneoff'] = 'True'
  const result = await planDevelopmentDependencies(
    [
      oneoff,
      container('agent-supervisor'),
      container('redis'),
      container('qdrant'),
    ],
    defaultPorts,
    { portAvailable: async () => true },
  )
  assert.deepEqual(result.start, ['postgres'])
  assert.deepEqual(result.ready, ['redis', 'qdrant'])
  assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '15432')
})

test('running managed services must have exactly one loopback binding', async () => {
  for (const bindings of [
    null,
    [],
    [{ HostIp: '0.0.0.0', HostPort: '15432' }],
    [
      { HostIp: '127.0.0.1', HostPort: '15432' },
      { HostIp: '127.0.0.1', HostPort: '25432' },
    ],
  ]) {
    const postgres = container('postgres')
    postgres.NetworkSettings.Ports['5432/tcp'] = bindings
    await assert.rejects(
      planDevelopmentDependencies([postgres], defaultPorts, {
        portAvailable: async () => true,
      }),
    )
  }
})

test('explicit shell ports cannot be silently replaced or disagree with a running service', async () => {
  await assert.rejects(
    planDevelopmentDependencies([], defaultPorts, {
      explicitEnvironment: { SUPERDSH_DEV_PG_PORT: '15432' },
      portAvailable: async (port) => port !== '15432',
    }),
  )
  await assert.rejects(
    planDevelopmentDependencies(
      [container('postgres', { hostPort: '25432' })],
      defaultPorts,
      {
        explicitEnvironment: { SUPERDSH_DEV_PG_PORT: '15432' },
        portAvailable: async () => true,
      },
    ),
  )
  const result = await planDevelopmentDependencies([], defaultPorts, {
    explicitEnvironment: defaultPorts,
    portAvailable: async () => true,
  })
  assert.deepEqual(result.ports, defaultPorts)
})

test('three dependencies cannot receive the same host port', async () => {
  const result = await planDevelopmentDependencies(
    [],
    {
      SUPERDSH_DEV_PG_PORT: '16379',
      SUPERDSH_DEV_REDIS_PORT: '16379',
      SUPERDSH_DEV_QDRANT_PORT: '16379',
    },
    { portAvailable: async () => true },
  )
  assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '16379')
  assert.equal(result.ports.SUPERDSH_DEV_REDIS_PORT, '16380')
  assert.equal(result.ports.SUPERDSH_DEV_QDRANT_PORT, '16381')
})

test('a missing dependency cannot claim the other running dependency port', async () => {
  const result = await planDevelopmentDependencies(
    [container('redis', { hostPort: '15432' }), container('qdrant')],
    defaultPorts,
    { portAvailable: async () => true },
  )
  assert.equal(result.ports.SUPERDSH_DEV_PG_PORT, '15433')
  assert.equal(result.ports.SUPERDSH_DEV_REDIS_PORT, '15432')
  assert.deepEqual(result.start, ['postgres'])
  assert.deepEqual(result.ready, ['redis', 'qdrant'])
})

test('port discovery has a bounded failure when no candidate is available', async () => {
  let probes = 0
  await assert.rejects(
    planDevelopmentDependencies([], defaultPorts, {
      portAvailable: async () => {
        probes += 1
        return false
      },
    }),
  )
  assert.ok(probes > 0)
  assert.ok(probes <= 101)
})

test('port discovery rejects invalid ports and never probes above the TCP port range', async () => {
  for (const value of ['0', '65536', '15432:5432'])
    await assert.rejects(
      planDevelopmentDependencies(
        [],
        { ...defaultPorts, SUPERDSH_DEV_PG_PORT: value },
        { portAvailable: async () => true },
      ),
    )
  const probed = []
  await assert.rejects(
    planDevelopmentDependencies(
      [],
      { ...defaultPorts, SUPERDSH_DEV_PG_PORT: '65535' },
      {
        portAvailable: async (port) => {
          probed.push(port)
          return false
        },
      },
    ),
  )
  assert.deepEqual(probed, ['65535'])
})

test('loopback probing detects an actual listener and releases its own probe sockets', async () => {
  const server = createServer()
  try {
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
    await once(server, 'listening')
    const port = String(server.address().port)
    assert.equal(await isLoopbackPortAvailable(port), false)
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    assert.equal(await isLoopbackPortAvailable(port), true)
    assert.equal(await isLoopbackPortAvailable(port), true)
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
})

test('persisted alternative ports survive reload without changing persistent credentials', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const original = parseEnv(readFileSync(file, 'utf8'))
  const ports = {
    SUPERDSH_DEV_PG_PORT: '15433',
    SUPERDSH_DEV_REDIS_PORT: '16380',
    SUPERDSH_DEV_QDRANT_PORT: '16334',
  }
  assert.equal(persistDevelopmentPorts(root, ports, {}), file)
  const saved = parseEnv(readFileSync(file, 'utf8'))
  assert.deepEqual(saved, { ...original, ...ports })
  const env = developmentEnvironment(root, {})
  assert.ok(
    env.AGENT_SERVER_DB_URL.endsWith('@127.0.0.1:15433/agents_anywhere'),
  )
  assert.equal(env.AGENT_SERVER_REDIS_URL, 'redis://127.0.0.1:16380/0')
  assert.equal(env.SUPERDSH_QDRANT_URL, 'http://127.0.0.1:16334')
  const first = readFileSync(file, 'utf8')
  persistDevelopmentPorts(root, ports, {})
  assert.equal(readFileSync(file, 'utf8'), first)
})

test('port persistence preserves unrelated env bytes, comments, secrets and custom env location', (t) => {
  const root = temporaryRepository(t)
  const file = join(root, 'custom.env')
  const source = [
    '# 自定义开发配置，必须原样保留',
    'POSTGRES_PASSWORD="test-secret-with-#-and-spaces "',
    'SUPERDSH_DEV_PG_PORT=15432',
    'AGENT_SERVER_SECRET=unchanged-test-secret',
    'SUPERDSH_DEV_REDIS_PORT=16379',
    'SUPERDSH_DEV_QDRANT_PORT=16333',
    'SUPERDSH_QDRANT_API_KEY="keep-this-test-key"',
    'CUSTOM_OPTION="a=b # untouched"',
    '',
  ].join('\r\n')
  writeFileSync(file, source, 'utf8')
  const ports = {
    SUPERDSH_DEV_PG_PORT: '25432',
    SUPERDSH_DEV_REDIS_PORT: '26379',
    SUPERDSH_DEV_QDRANT_PORT: '26333',
  }
  assert.equal(
    persistDevelopmentPorts(root, ports, {
      SUPERDSH_SERVER_DEV_ENV: 'custom.env',
    }),
    file,
  )
  assert.equal(
    readFileSync(file, 'utf8'),
    source
      .replace('SUPERDSH_DEV_PG_PORT=15432', 'SUPERDSH_DEV_PG_PORT=25432')
      .replace('SUPERDSH_DEV_REDIS_PORT=16379', 'SUPERDSH_DEV_REDIS_PORT=26379')
      .replace(
        'SUPERDSH_DEV_QDRANT_PORT=16333',
        'SUPERDSH_DEV_QDRANT_PORT=26333',
      ),
  )
})

test('port persistence adds missing settings without altering other settings', (t) => {
  const root = temporaryRepository(t)
  const file = join(root, 'custom.env')
  const source = '# Existing settings\nPOSTGRES_PASSWORD=test-only\n'
  writeFileSync(file, source, 'utf8')
  persistDevelopmentPorts(root, defaultPorts, {
    SUPERDSH_SERVER_DEV_ENV: 'custom.env',
  })
  const saved = readFileSync(file, 'utf8')
  assert.ok(saved.startsWith(source))
  assert.deepEqual(parseEnv(saved), {
    POSTGRES_PASSWORD: 'test-only',
    ...defaultPorts,
  })
})
