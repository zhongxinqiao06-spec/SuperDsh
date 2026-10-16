import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { bootstrapDeployment, deploymentEnvironment } from './bootstrap.mjs'

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'starbridge-bootstrap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = {
    populated: false,
    users: [],
    migrated: 0,
    released: 0,
    created: [],
  }
  const logs = []
  const environment = await deploymentEnvironment({
    SUPERDSH_DEPLOYMENT_DATA_DIR: directory,
    AGENT_SERVER_DB_URL: 'postgresql://test:test@localhost/test',
    ...overrides,
  })
  const options = {
    environment,
    database: {
      async lease(key) {
        assert.equal(key, 'superdsh:platform-api')
        return {
          lost: new Promise(() => {}),
          async release() {
            state.released++
          },
        }
      },
      async query(sql) {
        if (sql.includes('pg_class')) return [{ populated: state.populated }]
        assert.equal(sql, 'SELECT id FROM users LIMIT 1')
        return state.users
      },
    },
    async initializeIdentity(values) {
      assert.ok(values.AGENT_SERVER_SECRET)
      state.migrated++
      state.populated = true
      return {
        async createUser(credentials, settings) {
          assert.deepEqual(settings, { role: 'admin', bootstrap: true })
          state.created.push({ ...credentials })
          state.users.push({ id: 'test-user' })
        },
      }
    },
    log: (line) => logs.push(line),
  }
  return { directory, options, state, logs }
}

test('empty deployment creates durable unique secrets and a random administrator exactly once', async (t) => {
  const { directory, options, state, logs } = await fixture(t)
  const first = await bootstrapDeployment(options)
  const secretPath = join(directory, 'config/platform.env')
  const credentialPath = join(directory, 'config/initial-admin.txt')
  const saved = parseEnv(await readFile(secretPath, 'utf8'))
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'))
  for (const name of ['AGENT_SERVER_SECRET', 'SUPERDSH_MODEL_ENCRYPTION_KEY']) {
    assert.equal(saved[name], first[name])
    assert.equal(Buffer.from(first[name], 'base64url').length, 32)
  }
  assert.notEqual(
    first.AGENT_SERVER_SECRET,
    first.SUPERDSH_MODEL_ENCRYPTION_KEY,
  )
  assert.equal(credentials.username, 'admin')
  assert.equal(credentials.password.length, 32)
  assert.notEqual(credentials.password, 'admin123')
  assert.deepEqual(state.created, [credentials])
  assert.ok(logs.some((line) => line.includes(credentials.password)))
  assert.equal(first.NODE_ENV, 'production')
  assert.equal(first.SUPERDSH_BOOTSTRAP_DEV_ADMIN, '0')
  assert.equal(first.SUPERDSH_SERVER_HOST, '0.0.0.0')
  assert.equal(first.AGENT_SERVER_PUBLIC_ORIGIN, undefined)
  if (process.platform !== 'win32') {
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600)
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600)
  }
  logs.length = 0
  const second = await bootstrapDeployment(options)
  assert.equal(second.AGENT_SERVER_SECRET, first.AGENT_SERVER_SECRET)
  assert.equal(
    second.SUPERDSH_MODEL_ENCRYPTION_KEY,
    first.SUPERDSH_MODEL_ENCRYPTION_KEY,
  )
  assert.equal(state.created.length, 1)
  assert.equal(state.released, 2)
  assert.ok(logs.every((line) => !line.includes(credentials.password)))
})

test('explicit keys and first administrator are retained across restarts', async (t) => {
  const overrides = {
    AGENT_SERVER_SECRET: 'original-server-secret-with-$-and-#',
    SUPERDSH_MODEL_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    SUPERDSH_INITIAL_ADMIN_USERNAME: 'company_admin',
    SUPERDSH_INITIAL_ADMIN_PASSWORD: 'synthetic-custom-password',
    SUPERDSH_INITIAL_ADMIN_DISPLAY_NAME: '企业管理员',
    AGENT_SERVER_PUBLIC_ORIGIN: 'https://platform.example.com',
  }
  const { options, state } = await fixture(t, overrides)
  const result = await bootstrapDeployment(options)
  assert.equal(result.AGENT_SERVER_SECRET, overrides.AGENT_SERVER_SECRET)
  assert.equal(
    result.SUPERDSH_MODEL_ENCRYPTION_KEY,
    overrides.SUPERDSH_MODEL_ENCRYPTION_KEY,
  )
  assert.equal(
    result.AGENT_SERVER_PUBLIC_ORIGIN,
    overrides.AGENT_SERVER_PUBLIC_ORIGIN,
  )
  assert.deepEqual(state.created[0], {
    username: 'company_admin',
    password: 'synthetic-custom-password',
    displayName: '企业管理员',
  })
  await bootstrapDeployment({
    ...options,
    environment: {
      ...options.environment,
      SUPERDSH_INITIAL_ADMIN_PASSWORD: 'do-not-reset-this-password',
    },
  })
  assert.equal(state.created.length, 1)
})

test('existing database without original keys fails before schema or users are changed', async (t) => {
  const { directory, options, state } = await fixture(t)
  state.populated = true
  state.users = [{ id: 'retained-user' }]
  await assert.rejects(
    bootstrapDeployment(options),
    /AGENT_SERVER_SECRET is required for an existing database/,
  )
  assert.equal(state.migrated, 0)
  assert.equal(state.created.length, 0)
  assert.equal(state.released, 1)
  await assert.rejects(readFile(join(directory, 'config/platform.env')), {
    code: 'ENOENT',
  })
})

test('existing database accepts restored keys and never creates or resets an administrator', async (t) => {
  const { directory, options, state } = await fixture(t, {
    AGENT_SERVER_SECRET: randomBytes(32).toString('base64url'),
    SUPERDSH_MODEL_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  })
  state.populated = true
  state.users = [{ id: 'retained-user' }]
  await bootstrapDeployment(options)
  assert.equal(state.migrated, 1)
  assert.equal(state.created.length, 0)
  await assert.rejects(readFile(join(directory, 'config/initial-admin.txt')), {
    code: 'ENOENT',
  })
})

test('a conflicting key override cannot silently replace persisted encryption credentials', async (t) => {
  const { options, state } = await fixture(t)
  const initial = await bootstrapDeployment(options)
  for (const name of ['AGENT_SERVER_SECRET', 'SUPERDSH_MODEL_ENCRYPTION_KEY']) {
    await assert.rejects(
      bootstrapDeployment({
        ...options,
        environment: {
          ...options.environment,
          [name]: randomBytes(32).toString('base64url'),
        },
      }),
      new RegExp(`${name} differs from saved platform.env`),
    )
  }
  const retained = await bootstrapDeployment(options)
  assert.equal(retained.AGENT_SERVER_SECRET, initial.AGENT_SERVER_SECRET)
  assert.equal(
    retained.SUPERDSH_MODEL_ENCRYPTION_KEY,
    initial.SUPERDSH_MODEL_ENCRYPTION_KEY,
  )
  assert.equal(state.created.length, 1)
})

test('incomplete persisted configuration is rejected instead of generating replacement keys', async (t) => {
  const { directory, options, state } = await fixture(t)
  await bootstrapDeployment(options)
  await writeFile(
    join(directory, 'config/platform.env'),
    'AGENT_SERVER_SECRET=retained\n',
  )
  const migrations = state.migrated
  await assert.rejects(
    bootstrapDeployment(options),
    /SUPERDSH_MODEL_ENCRYPTION_KEY is missing from saved/,
  )
  assert.equal(state.migrated, migrations)
  assert.equal(state.created.length, 1)
})

test('failed account initialization retries with the same saved password', async (t) => {
  const { directory, options, state } = await fixture(t)
  const initialize = options.initializeIdentity
  options.initializeIdentity = async (values) => {
    await initialize(values)
    return {
      async createUser() {
        throw new Error('synthetic transaction failure')
      },
    }
  }
  await assert.rejects(
    bootstrapDeployment(options),
    /synthetic transaction failure/,
  )
  const credentials = JSON.parse(
    await readFile(join(directory, 'config/initial-admin.txt'), 'utf8'),
  )
  options.initializeIdentity = initialize
  await bootstrapDeployment(options)
  assert.deepEqual(state.created, [credentials])
  assert.equal(state.released, 2)
})

test('another active platform blocks initialization before any configuration is written', async (t) => {
  const { directory, options, state } = await fixture(t)
  options.database.lease = async () => null
  await assert.rejects(
    bootstrapDeployment(options),
    /Another platform owns this database/,
  )
  assert.equal(state.migrated, 0)
  await assert.rejects(readFile(join(directory, 'config/platform.env')), {
    code: 'ENOENT',
  })
})

test('invalid supplied encryption keys and administrator passwords fail without creating accounts', async (t) => {
  const { options, state } = await fixture(t, {
    SUPERDSH_MODEL_ENCRYPTION_KEY: 'invalid',
  })
  await assert.rejects(bootstrapDeployment(options), /must encode 32 bytes/)
  assert.equal(state.migrated, 0)
  delete options.environment.SUPERDSH_MODEL_ENCRYPTION_KEY
  options.environment.SUPERDSH_INITIAL_ADMIN_PASSWORD = 'short'
  await assert.rejects(
    bootstrapDeployment(options),
    /8-1024 character password/,
  )
  assert.equal(state.created.length, 0)
})

test('database URL is derived from the shared password file without losing special characters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'starbridge-db-url-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password')
  await writeFile(passwordFile, 'synthetic:p@ss/#$\n')
  const environment = await deploymentEnvironment({
    SUPERDSH_DEPLOYMENT_DATA_DIR: directory,
    POSTGRES_PASSWORD_FILE: passwordFile,
  })
  const url = new URL(environment.AGENT_SERVER_DB_URL)
  assert.equal(url.hostname, 'postgres')
  assert.equal(url.port, '5432')
  assert.equal(url.username, 'agents_anywhere')
  assert.equal(url.pathname, '/agents_anywhere')
  assert.equal(decodeURIComponent(url.password), 'synthetic:p@ss/#$')
  const explicit = await deploymentEnvironment({
    AGENT_SERVER_DB_URL: 'postgresql://external.example.com/platform',
    POSTGRES_PASSWORD_FILE: join(directory, 'missing-file'),
  })
  assert.equal(
    explicit.AGENT_SERVER_DB_URL,
    'postgresql://external.example.com/platform',
  )
})
