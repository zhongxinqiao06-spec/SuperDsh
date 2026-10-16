import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  assert.equal(env.SUPERDSH_NATIVE_PLATFORM, '1')
  assert.equal(env.SUPERDSH_AGENT_SUPERVISOR_URL, '')
  assert.ok(
    env.AGENT_SERVER_DB_URL.endsWith('@127.0.0.1:15432/agents_anywhere'),
  )
  assert.equal(env.AGENT_SERVER_REDIS_URL, 'redis://127.0.0.1:16379/0')
  assert.equal(env.SUPERDSH_QDRANT_URL, 'http://127.0.0.1:16333')
  assert.equal(env.SUPERDSH_DEV_QDRANT_PORT, '16333')
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
  assert.ok(args.at(-1).endsWith('compose.dependencies.yml'))
  assert.ok(!args.some((value) => value.includes('mobile-link-test')))
})

test('an older env gains Qdrant defaults without rewriting secrets and accepts explicit secured endpoints', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const original = readFileSync(file, 'utf8').replace(
    'SUPERDSH_DEV_QDRANT_PORT=16333\n',
    '',
  )
  writeFileSync(file, original)
  assert.equal(
    developmentEnvironment(root, {}).SUPERDSH_QDRANT_URL,
    'http://127.0.0.1:16333',
  )
  assert.equal(readFileSync(file, 'utf8'), original)
  const env = developmentEnvironment(root, {
    SUPERDSH_QDRANT_URL: 'https://vector.example.test',
    SUPERDSH_QDRANT_API_KEY: 'synthetic-qdrant-only-secret',
    SUPERDSH_DEV_QDRANT_PORT: '26333',
  })
  assert.equal(env.SUPERDSH_QDRANT_URL, 'https://vector.example.test')
  assert.equal(env.SUPERDSH_QDRANT_API_KEY, 'synthetic-qdrant-only-secret')
  assert.equal(env.SUPERDSH_DEV_QDRANT_PORT, '26333')
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.throws(
    () => developmentEnvironment(root, { SUPERDSH_DEV_QDRANT_PORT: '65536' }),
    /SUPERDSH_DEV_QDRANT_PORT/,
  )
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

test('native development ignores stale Supervisor routing without changing saved credentials', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const saved = `${readFileSync(file, 'utf8')}SUPERDSH_DEV_AGENT_ENABLED=1\nSUPERDSH_AGENT_SUPERVISOR_URL=http://127.0.0.1:18090\nSUPERDSH_AGENT_SUPERVISOR_SECRET=saved-agent-secret\nSUPERDSH_AGENT_SERVER_URL=http://server-next:8000\n`
  writeFileSync(file, saved)
  const env = developmentEnvironment(root, {
    SUPERDSH_DEV_AGENT_ENABLED: '0',
  })
  assert.equal(env.SUPERDSH_NATIVE_PLATFORM, '1')
  for (const field of [
    'SUPERDSH_AGENT_SUPERVISOR_URL',
    'SUPERDSH_AGENT_SUPERVISOR_SECRET',
    'SUPERDSH_AGENT_SERVER_URL',
  ])
    assert.equal(env[field], '')
  assert.equal(readFileSync(file, 'utf8'), saved)
})

test('one development command starts Node without Python or Agent containers', (t) => {
  const root = temporaryRepository(t)
  const file = prepareDevelopmentEnv(root, {})
  const saved = `${readFileSync(file, 'utf8')}SUPERDSH_DEV_AGENT_ENABLED=1\nSUPERDSH_AGENT_SUPERVISOR_URL=http://127.0.0.1:18090\nSUPERDSH_AGENT_SUPERVISOR_SECRET=saved-agent-secret\n`
  writeFileSync(file, saved)
  const cli = new URL('./server.mjs', import.meta.url).href
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('SUPERDSH_') &&
          !key.startsWith('AGENT_SERVER_') &&
          !key.startsWith('AGENT_CONNECTOR_'),
      ),
    ),
    SUPERDSH_SERVER_DEV_ENV: file,
    // A leftover opt-in must not turn the plain dev command into Docker setup.
    SUPERDSH_DEV_AGENT_ENABLED: '1',
  }
  for (const action of ['dev', 'dev-agents']) {
    const code = `
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      import { EventEmitter } from 'node:events'
      const calls = []
      childProcess.spawn = (command, args, options) => {
        calls.push({ command, args, supervisor: options.env.SUPERDSH_AGENT_SUPERVISOR_URL })
        const child = new EventEmitter()
        process.nextTick(() => child.emit('exit', 0))
        return child
      }
      childProcess.spawnSync = (command, args) => {
        calls.push({ command, args })
        if (command !== 'docker') throw new Error('Unexpected synchronous process')
        if (args[0] === 'info') return { status: 0, stdout: 'linux' }
        if (args[0] === 'ps') return { status: 0, stdout: 'fixture-postgres' }
        if (args[0] === 'inspect') return {
          status: 0,
          stdout: JSON.stringify([{
            State: { Running: true },
            Config: { Labels: {
              'com.docker.compose.project': 'superdsh-dev',
              'com.docker.compose.service': 'postgres',
            } },
            NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] } },
          }]),
        }
        if (args[0] === 'image') return { status: 1, stdout: '' }
        throw new Error('Unexpected Docker invocation')
      }
      syncBuiltinESMExports()
      process.argv = [process.execPath, 'server.mjs', ${JSON.stringify(action)}]
      process.on('beforeExit', () => console.log('CLI_CALLS=' + JSON.stringify(calls)))
      await import(${JSON.stringify(cli)})
    `
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', code],
      { env: environment, encoding: 'utf8', timeout: 15000 },
    )
    const record = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith('CLI_CALLS='))
    assert.ok(record)
    const calls = JSON.parse(record.slice('CLI_CALLS='.length))
    const api = calls.find((call) =>
      call.args.some(
        (arg) =>
          arg.endsWith('server/main.ts') || arg.endsWith('server\\main.ts'),
      ),
    )
    assert.ok(api)
    assert.equal(api.command, process.execPath)
    assert.equal(api.supervisor, '')
    const dockerWrites = calls.filter(
      (call) =>
        call.command === 'docker' &&
        !['ps', 'inspect', 'info'].includes(call.args[0]),
    )
    assert.deepEqual(dockerWrites, [])
    assert.ok(
      calls.every(
        (call) =>
          call.command === 'docker' || call.command === process.execPath,
      ),
    )
    assert.equal(readFileSync(file, 'utf8'), saved)
  }
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
  assert.equal(env.SUPERDSH_NATIVE_PLATFORM, '1')
  assert.equal(env.SUPERDSH_AGENT_SUPERVISOR_URL, '')
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
