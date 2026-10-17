import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { bootstrapDeployment, deploymentEnvironment } from './bootstrap.mjs'
import { IdentityService } from '../server/identity/service.ts'

const upgradeKey = 'deployment.initial-admin-password.v1'

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'starbridge-bootstrap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = {
    populated: false,
    users: [],
    migrated: 0,
    released: 0,
    created: [],
    settings: {},
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
      async transaction(operation) {
        const settings = { ...state.settings }
        const result = await operation({
          settings,
          async query(sql) {
            assert.equal(sql, 'SELECT pg_advisory_xact_lock(4141455)')
            return []
          },
        })
        state.settings = settings
        return result
      },
    },
    async initializeIdentity(values) {
      assert.ok(values.AGENT_SERVER_SECRET)
      state.migrated++
      state.populated = true
      return {
        async getSetting(key, connection) {
          return connection.settings[key] ?? null
        },
        async setSetting(key, value, connection) {
          connection.settings[key] = value
        },
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

test('empty deployment creates durable unique secrets and the default administrator exactly once', async (t) => {
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
  assert.equal(credentials.password, 'admin123')
  assert.deepEqual(state.created, [credentials])
  assert.equal(state.settings[upgradeKey], 'new-deployment')
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
  const { directory, options, state } = await fixture(t, {
    SUPERDSH_INITIAL_ADMIN_PASSWORD: 'previously-generated-password',
  })
  const initialize = options.initializeIdentity
  options.initializeIdentity = async (values) => {
    const identity = await initialize(values)
    return {
      ...identity,
      async createUser() {
        throw new Error('synthetic transaction failure')
      },
    }
  }
  await assert.rejects(
    bootstrapDeployment(options),
    /synthetic transaction failure/,
  )
  assert.equal(state.settings[upgradeKey], 'new-deployment')
  const credentials = JSON.parse(
    await readFile(join(directory, 'config/initial-admin.txt'), 'utf8'),
  )
  options.environment.SUPERDSH_INITIAL_ADMIN_PASSWORD = 'admin123'
  options.initializeIdentity = initialize
  await bootstrapDeployment(options)
  assert.equal(credentials.password, 'previously-generated-password')
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

async function legacyFixture(t) {
  const f = await fixture(t, {
    AGENT_SERVER_SECRET: 'synthetic-retained-signing-key',
    SUPERDSH_MODEL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  })
  const { state, options, directory } = f
  const original = {
    username: 'admin',
    password: 'synthetic-previous-initial-password',
    displayName: 'Initial admin',
  }
  const credentialPath = join(directory, 'config/initial-admin.txt')
  await mkdir(join(directory, 'config'), { recursive: true })
  await writeFile(credentialPath, JSON.stringify(original))
  state.populated = true
  state.users = [
    {
      id: 'synthetic-admin',
      username: 'admin',
      role: 'admin',
      disabled: 0,
      deleted_at: null,
      auth_version: 3,
      reset_required: 0,
    },
    {
      id: 'synthetic-member',
      username: 'member',
      role: 'member',
      auth_version: 8,
    },
  ]
  state.assignments = ['admin']
  state.sessions = [
    { user_id: 'synthetic-admin', revoked_at: null },
    { user_id: 'synthetic-member', revoked_at: null },
  ]
  state.recovery = ['synthetic-admin', 'synthetic-member']
  state.audit = []
  const controls = { failSetting: false, loseDuringAudit: false }
  options.database.lease = async () => ({
    lost: new Promise((resolve) => {
      controls.loseOwnership = resolve
    }),
    async release() {
      state.released++
    },
  })
  options.database.transaction = async (operation) => {
    const draft = structuredClone(state)
    const result = await operation({
      async query(sql, values = []) {
        if (sql === 'SELECT pg_advisory_xact_lock(4141455)') return []
        if (sql === 'SELECT value FROM instance_settings WHERE key=$1')
          return draft.settings[values[0]]
            ? [{ value: draft.settings[values[0]] }]
            : []
        if (sql.startsWith('INSERT INTO instance_settings(')) {
          if (controls.failSetting)
            throw new Error('synthetic marker write failure')
          draft.settings[values[0]] = values[1]
          return []
        }
        if (
          sql ===
          'SELECT id,password_hash FROM users WHERE username=$1 FOR UPDATE'
        )
          return draft.users.filter((user) => user.username === values[0])
        if (sql === 'SELECT * FROM users WHERE id=$1')
          return draft.users.filter((user) => user.id === values[0])
        if (
          sql ===
          'SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id'
        )
          return draft.assignments.map((role_id) => ({ role_id }))
        if (
          sql === 'SELECT permissions_json FROM roles WHERE id=ANY($1::text[])'
        )
          return [{ permissions_json: '[]' }]
        if (sql.startsWith('UPDATE users SET password_hash=')) {
          const user = draft.users.find(
            (item) => item.id === values[0] && !item.deleted_at,
          )
          if (!user) return []
          user.password_hash = values[1]
          user.auth_version++
          user.reset_required = 0
          user.updated_at = values[2]
          return [{ id: user.id }]
        }
        if (sql === 'UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1') {
          for (const session of draft.sessions)
            if (session.user_id === values[0]) session.revoked_at = values[1]
          return []
        }
        if (sql === 'DELETE FROM recovery_codes WHERE user_id=$1') {
          draft.recovery = draft.recovery.filter((id) => id !== values[0])
          return []
        }
        if (sql.startsWith('INSERT INTO identity_audit(')) {
          draft.audit.push({
            actor: values[1],
            action: values[2],
            target: values[3],
            detail: JSON.parse(values[5]),
          })
          if (controls.loseDuringAudit)
            controls.loseOwnership(new Error('synthetic ownership loss'))
          return []
        }
        throw new Error(`Unexpected SQL in isolated bootstrap test: ${sql}`)
      },
    })
    for (const key of ['users', 'settings', 'sessions', 'recovery', 'audit'])
      state[key] = draft[key]
    return result
  }
  const identity = new IdentityService(options.database, {
    secret: 'synthetic-bootstrap-test',
  })
  state.users[0].password_hash = await identity.passwordHash({
    password: original.password,
  })
  options.initializeIdentity = async () => {
    state.migrated++
    return identity
  }
  return { ...f, identity, original, credentialPath, controls }
}

test('legacy unchanged initial password upgrades once with credential revocation and an atomic marker', async (t) => {
  const f = await legacyFixture(t)
  const member = structuredClone(f.state.users[1])
  const result = await bootstrapDeployment(f.options)
  const user = f.state.users[0]
  assert.equal(
    await f.identity.crypto.verifyPassword('admin123', user.password_hash),
    true,
  )
  assert.equal(
    await f.identity.crypto.verifyPassword(
      f.original.password,
      user.password_hash,
    ),
    false,
  )
  assert.equal(user.auth_version, 4)
  assert.ok(f.state.sessions[0].revoked_at)
  assert.equal(f.state.sessions[1].revoked_at, null)
  assert.deepEqual(f.state.recovery, ['synthetic-member'])
  assert.deepEqual(f.state.users[1], member)
  assert.equal(f.state.settings[upgradeKey], 'upgraded')
  assert.deepEqual(f.state.audit, [
    {
      actor: 'deployment-bootstrap',
      action: 'user.initial_password_upgraded',
      target: user.id,
      detail: { source: 'deployment-bootstrap', upgrade: upgradeKey },
    },
  ])
  assert.deepEqual(
    JSON.parse(await readFile(f.credentialPath, 'utf8')),
    f.original,
  )
  assert.equal(
    result.AGENT_SERVER_SECRET,
    f.options.environment.AGENT_SERVER_SECRET,
  )
  assert.equal(
    result.SUPERDSH_MODEL_ENCRYPTION_KEY,
    f.options.environment.SUPERDSH_MODEL_ENCRYPTION_KEY,
  )
  assert.ok(f.logs.some((line) => line.includes('upgraded once')))
  assert.ok(
    f.logs.every(
      (line) =>
        !line.includes(f.original.password) && !line.includes('admin123'),
    ),
  )

  const changed = await f.identity.passwordHash({
    password: 'later-user-selected-password',
  })
  f.state.users[0].password_hash = changed
  f.options.environment.SUPERDSH_INITIAL_ADMIN_PASSWORD =
    'later-configured-password'
  await bootstrapDeployment(f.options)
  assert.equal(f.state.users[0].password_hash, changed)
  assert.equal(f.state.users[0].auth_version, 4)
  assert.equal(f.state.audit.length, 1)
})

test('legacy upgrade honors the configured initial password and avoids revocation when already current', async (t) => {
  const custom = await legacyFixture(t)
  custom.options.environment.SUPERDSH_INITIAL_ADMIN_PASSWORD =
    'synthetic-configured-password'
  await bootstrapDeployment(custom.options)
  assert.equal(
    await custom.identity.crypto.verifyPassword(
      'synthetic-configured-password',
      custom.state.users[0].password_hash,
    ),
    true,
  )
  assert.equal(
    await custom.identity.crypto.verifyPassword(
      'admin123',
      custom.state.users[0].password_hash,
    ),
    false,
  )
  const current = await legacyFixture(t)
  current.options.environment.SUPERDSH_INITIAL_ADMIN_PASSWORD =
    current.original.password
  await bootstrapDeployment(current.options)
  assert.equal(current.state.settings[upgradeKey], 'already-current')
  assert.equal(current.state.users[0].auth_version, 3)
  assert.equal(current.state.sessions[0].revoked_at, null)
  assert.deepEqual(current.state.audit, [])
})

test('a password already changed by the administrator is preserved and never reconsidered', async (t) => {
  const f = await legacyFixture(t)
  const changed = await f.identity.passwordHash({
    password: 'already-selected-password',
  })
  f.state.users[0].password_hash = changed
  await bootstrapDeployment(f.options)
  assert.equal(f.state.users[0].password_hash, changed)
  assert.equal(f.state.settings[upgradeKey], 'preserved-changed-password')
  assert.equal(f.state.sessions[0].revoked_at, null)
  assert.deepEqual(f.state.audit, [])
  const originalHash = await f.identity.passwordHash({
    password: f.original.password,
  })
  f.state.users[0].password_hash = originalHash
  await bootstrapDeployment(f.options)
  assert.equal(f.state.users[0].password_hash, originalHash)
})

test('legacy missing, invalid or mismatched records and unavailable administrators keep their passwords', async (t) => {
  for (const scenario of [
    'missing-file',
    'invalid-file',
    'other-username',
    'missing-user',
    'member',
    'disabled',
    'deleted',
  ]) {
    await t.test(scenario, async (t) => {
      const f = await legacyFixture(t)
      if (scenario === 'missing-file') await rm(f.credentialPath)
      if (scenario === 'invalid-file')
        await writeFile(f.credentialPath, '{invalid')
      if (scenario === 'other-username')
        await writeFile(
          f.credentialPath,
          JSON.stringify({ ...f.original, username: 'someone-else' }),
        )
      if (scenario === 'missing-user') f.state.users.shift()
      if (scenario === 'member') f.state.assignments = ['member']
      if (scenario === 'disabled') f.state.users[0].disabled = 1
      if (scenario === 'deleted') f.state.users[0].deleted_at = '2026-01-01'
      const users = structuredClone(f.state.users)
      await bootstrapDeployment(f.options)
      assert.deepEqual(f.state.users, users)
      assert.match(f.state.settings[upgradeKey], /^preserved-/)
      assert.deepEqual(f.state.audit, [])
      assert.equal(f.state.sessions[0].revoked_at, null)
      assert.equal(f.state.released, 1)
    })
  }
})

test('failed upgrade marker and lost ownership roll back the password, sessions and audit before retry', async (t) => {
  for (const failure of ['marker', 'ownership']) {
    await t.test(failure, async (t) => {
      const f = await legacyFixture(t)
      const originalHash = f.state.users[0].password_hash
      f.controls.failSetting = failure === 'marker'
      f.controls.loseDuringAudit = failure === 'ownership'
      await assert.rejects(
        bootstrapDeployment(f.options),
        /marker write failure|ownership lost/,
      )
      assert.equal(f.state.users[0].password_hash, originalHash)
      assert.equal(f.state.users[0].auth_version, 3)
      assert.equal(f.state.sessions[0].revoked_at, null)
      assert.deepEqual(f.state.recovery, [
        'synthetic-admin',
        'synthetic-member',
      ])
      assert.deepEqual(f.state.audit, [])
      assert.equal(f.state.settings[upgradeKey], undefined)
      f.controls.failSetting = false
      f.controls.loseDuringAudit = false
      await bootstrapDeployment(f.options)
      assert.equal(
        await f.identity.crypto.verifyPassword(
          'admin123',
          f.state.users[0].password_hash,
        ),
        true,
      )
      assert.equal(f.state.settings[upgradeKey], 'upgraded')
      assert.equal(f.state.released, 2)
    })
  }
})
