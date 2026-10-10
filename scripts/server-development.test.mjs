import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import {
  developmentComposeArgs,
  developmentEnvironment,
  prepareDevelopmentEnv,
  prepareDevelopmentAgentEnv,
  verifyDevelopmentDatabaseContainer,
} from './server-development.mjs'

function temporaryRepository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'superdsh-server-dev-')))
  t.after(() => {
    assert.ok(root.startsWith(`${realpathSync(tmpdir())}${sep}`))
    assert.ok(root.includes('superdsh-server-dev-'))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('development credentials persist and use an independent project and data directory', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const original = readFileSync(file, 'utf8')
  assert.equal(prepareDevelopmentEnv(root, {}), file)
  assert.equal(readFileSync(file, 'utf8'), original)
  const env = developmentEnvironment(root, {})
  assert.equal(env.SUPERDSH_BOOTSTRAP_DEV_ADMIN, '1')
  assert.ok(
    env.AGENT_SERVER_DB_URL.endsWith('@127.0.0.1:15432/agents_anywhere'),
  )
  assert.equal(env.AGENT_SERVER_REDIS_URL, 'redis://127.0.0.1:16379/0')
  assert.equal(
    Buffer.from(env.SUPERDSH_MODEL_ENCRYPTION_KEY, 'base64url').length,
    32,
  )
  assert.ok(
    env.AGENT_SERVER_FILES_LOCAL_ROOT.startsWith(
      join(root, '.superdsh-work/server-dev'),
    ),
  )
  const args = developmentComposeArgs(root, file)
  assert.equal(args[args.indexOf('--project-name') + 1], 'superdsh-dev')
  assert.ok(args.at(-1).endsWith('compose.dev.yml'))
  assert.ok(!args.some((value) => value.includes('mobile-link-test')))
})

test('local frontend origin is trusted for refresh and logout without trusting deployment origins', (t) => {
  const root = temporaryRepository(t)
  prepareDevelopmentEnv(root, {})
  const env = developmentEnvironment(root, {})
  assert.equal(env.AGENT_SERVER_PUBLIC_ORIGIN, 'http://127.0.0.1:5174')
  assert.deepEqual(env.AGENT_SERVER_CORS_ORIGINS.split(','), [
    'http://127.0.0.1:5174',
    'http://localhost:5174',
  ])
})

test('native API development persists isolated Agent credentials and allows computer-only mode', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const before = parseEnv(readFileSync(file, 'utf8'))
  const env = prepareDevelopmentAgentEnv(root, {})
  assert.equal(env.SUPERDSH_DEV_AGENT_ENABLED, '1')
  assert.equal(env.SUPERDSH_AGENT_SUPERVISOR_URL, 'http://127.0.0.1:18090')
  assert.equal(env.SUPERDSH_AGENT_SERVER_URL, 'http://server-next:8000')
  assert.ok(env.SUPERDSH_AGENT_SUPERVISOR_SECRET.length >= 32)
  assert.equal(env.POSTGRES_PASSWORD, before.POSTGRES_PASSWORD)
  assert.equal(env.AGENT_SERVER_SECRET, before.AGENT_SERVER_SECRET)
  assert.equal(
    prepareDevelopmentAgentEnv(root, {}).SUPERDSH_AGENT_SUPERVISOR_SECRET,
    env.SUPERDSH_AGENT_SUPERVISOR_SECRET,
  )
  const disabled = developmentEnvironment(root, {
    SUPERDSH_DEV_AGENT_ENABLED: '0',
  })
  assert.equal(disabled.SUPERDSH_DEV_AGENT_ENABLED, '0')
  assert.equal(disabled.SUPERDSH_AGENT_SUPERVISOR_URL, undefined)
})

test('missing configuration does not silently select an existing user database', (t) => {
  const root = temporaryRepository(t)
  assert.throws(() => developmentEnvironment(root, {}), /server:deps:up/u)
  assert.throws(
    () =>
      prepareDevelopmentEnv(root, {
        SUPERDSH_SERVER_DEV_ENV: 'missing.env',
      }),
    /does not exist/u,
  )
  assert.throws(
    () =>
      developmentEnvironment(root, {
        AGENT_SERVER_DB_URL: 'postgresql+asyncpg://local/dev',
      }),
    /both/u,
  )
})

test('native dependencies bypass Docker and explicit server credentials remain unchanged', (t) => {
  const root = temporaryRepository(t)
  const options = {
    AGENT_SERVER_DB_URL:
      'postgresql+asyncpg://local:password@localhost:5432/dev',
    AGENT_SERVER_REDIS_URL: 'redis://localhost:6379/4',
    AGENT_SERVER_SECRET: 'explicit-dev-secret',
    SUPERDSH_MODEL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  }
  const env = developmentEnvironment(root, options)
  assert.equal(env.SUPERDSH_BOOTSTRAP_DEV_ADMIN, '0')
  assert.equal(env.SUPERDSH_DEV_AGENT_ENABLED, '0')
  assert.equal(env.SUPERDSH_AGENT_SUPERVISOR_URL, undefined)
  for (const [key, value] of Object.entries(options))
    assert.equal(env[key], value)
})

test('saved external database URLs and caller flags cannot enable default admin creation', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const externalUrl =
    'postgresql+asyncpg://local:password@localhost:5432/shared'
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}AGENT_SERVER_DB_URL=${externalUrl}\nAGENT_SERVER_REDIS_URL=redis://localhost:6379/4\nSUPERDSH_BOOTSTRAP_DEV_ADMIN=1\n`,
  )
  const env = developmentEnvironment(root, {
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: '1',
  })
  assert.equal(env.AGENT_SERVER_DB_URL, externalUrl)
  assert.equal(env.SUPERDSH_BOOTSTRAP_DEV_ADMIN, '0')
})

test('database passwords are URL encoded and invalid exposed ports are rejected', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const original = parseEnv(readFileSync(file, 'utf8'))
  writeFileSync(
    file,
    Object.entries({ ...original, POSTGRES_PASSWORD: 'p@: /#' })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n'),
  )
  const env = developmentEnvironment(root, {})
  assert.ok(env.AGENT_SERVER_DB_URL.includes('p%40%3A%20%2F%23@'))
  for (const value of ['0', '65536', '15432:5432'])
    assert.throws(
      () =>
        developmentEnvironment(root, {
          SUPERDSH_DEV_PG_PORT: value,
        }),
      /port from/u,
    )
})

test('default admin initialization verifies container ownership and the actual database port', () => {
  const environment = {
    AGENT_SERVER_DB_URL:
      'postgresql+asyncpg://agents_anywhere:password@127.0.0.1:15432/agents_anywhere',
  }
  const container = {
    State: { Running: true },
    Config: {
      Labels: {
        'com.docker.compose.project': 'superdsh-dev',
        'com.docker.compose.service': 'postgres',
      },
    },
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] },
    },
  }
  assert.doesNotThrow(() =>
    verifyDevelopmentDatabaseContainer(container, environment),
  )
  for (const mutate of [
    (value) => {
      value.State.Running = false
    },
    (value) => {
      value.Config.Labels['com.docker.compose.project'] = 'production'
    },
    (value) => {
      value.Config.Labels['com.docker.compose.service'] = 'other'
    },
    (value) => {
      value.NetworkSettings.Ports['5432/tcp'][0].HostPort = '25432'
    },
    (value) => {
      value.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'
    },
  ]) {
    const other = structuredClone(container)
    mutate(other)
    assert.throws(
      () => verifyDevelopmentDatabaseContainer(other, environment),
      /running superdsh-dev PostgreSQL/u,
    )
  }
})
