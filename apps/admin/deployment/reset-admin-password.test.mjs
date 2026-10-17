import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { IdentityService } from '../server/identity/service.ts'
import {
  parseResetArguments,
  readPasswordInput,
  resetAdminPassword,
  runResetCommand,
} from './reset-admin-password.mjs'

async function fixture(options = {}) {
  let loseOwnership
  const state = {
    users: [
      {
        id: 'synthetic-admin',
        username: 'admin',
        role: 'admin',
        disabled: 0,
        deleted_at: null,
        reset_required: 1,
        auth_version: 4,
      },
      { id: 'other-user', username: 'other', role: 'member', auth_version: 7 },
    ],
    assignments: ['admin'],
    sessions: [
      { user_id: 'synthetic-admin', revoked_at: null },
      { user_id: 'other-user', revoked_at: null },
    ],
    recovery: ['synthetic-admin', 'other-user'],
    audit: [],
    released: 0,
    closed: 0,
    committed: 0,
    queries: [],
  }
  const ownership = {
    lost: new Promise((resolve) => {
      loseOwnership = resolve
    }),
    async release() {
      state.released++
      if (options.failRelease)
        throw new Error('synthetic lease release failure')
    },
  }
  const database = {
    async lease(key) {
      assert.equal(key, 'superdsh:platform-api')
      if (options.busy) return null
      if (options.initiallyLost)
        loseOwnership(new Error('synthetic lease loss'))
      return ownership
    },
    async transaction(operation) {
      const draft = structuredClone(state)
      const connection = {
        async query(sql, values = []) {
          state.queries.push(sql)
          if (options.onQuery) await options.onQuery(sql, loseOwnership)
          if (sql === 'SELECT pg_advisory_xact_lock(4141455)') return []
          if (sql === 'SELECT id FROM users WHERE username=$1 FOR UPDATE')
            return draft.users
              .filter((row) => row.username === values[0])
              .map(({ id }) => ({ id }))
          if (sql === 'SELECT * FROM users WHERE id=$1')
            return draft.users.filter((row) => row.id === values[0])
          if (
            sql ===
            'SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id'
          )
            return draft.assignments.map((role_id) => ({ role_id }))
          if (
            sql ===
            'SELECT permissions_json FROM roles WHERE id=ANY($1::text[])'
          )
            return [{ permissions_json: '[]' }]
          if (sql.startsWith('UPDATE users SET password_hash=')) {
            const user = draft.users.find(
              (row) => row.id === values[0] && !row.deleted_at,
            )
            if (!user) return []
            user.password_hash = values[1]
            user.auth_version++
            user.reset_required = 0
            user.updated_at = values[2]
            return [{ id: user.id }]
          }
          if (
            sql === 'UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1'
          ) {
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
            return []
          }
          throw new Error(`Unexpected SQL in isolated test: ${sql}`)
        },
      }
      await operation(connection)
      for (const key of [
        'users',
        'assignments',
        'sessions',
        'recovery',
        'audit',
      ])
        state[key] = draft[key]
      state.committed++
    },
    async close() {
      state.closed++
    },
  }
  const identity = new IdentityService(database, {
    secret: 'synthetic-reset-test',
  })
  state.users[0].password_hash = await identity.passwordHash({
    password: 'synthetic-old-password',
  })
  const reset = (overrides = {}) =>
    resetAdminPassword({
      database,
      identity,
      username: 'admin',
      password: 'synthetic-new-password',
      ...overrides,
    })
  return { state, database, identity, reset }
}

test('offline reset changes only the existing administrator and revokes credentials atomically', async () => {
  const f = await fixture()
  const other = structuredClone(f.state.users[1])
  await f.reset()
  const user = f.state.users[0]
  assert.equal(
    await f.identity.crypto.verifyPassword(
      'synthetic-new-password',
      user.password_hash,
    ),
    true,
  )
  assert.equal(
    await f.identity.crypto.verifyPassword(
      'synthetic-old-password',
      user.password_hash,
    ),
    false,
  )
  assert.equal(user.auth_version, 5)
  assert.equal(user.reset_required, 0)
  assert.ok(f.state.sessions[0].revoked_at)
  assert.equal(f.state.sessions[1].revoked_at, null)
  assert.deepEqual(f.state.recovery, ['other-user'])
  assert.deepEqual(f.state.users[1], other)
  assert.deepEqual(f.state.audit, [
    {
      actor: 'deployment-cli',
      action: 'user.password_reset',
      target: 'synthetic-admin',
      detail: { source: 'deployment-cli' },
    },
  ])
  assert.deepEqual(f.state.queries.slice(0, 2), [
    'SELECT pg_advisory_xact_lock(4141455)',
    'SELECT id FROM users WHERE username=$1 FOR UPDATE',
  ])
  assert.equal(f.state.committed, 1)
  assert.equal(f.state.released, 1)
  assert.equal(f.state.closed, 1)
})

test('running platforms block recovery without opening a write transaction', async () => {
  const f = await fixture({ busy: true })
  await assert.rejects(f.reset(), /Stop the platform service/)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.committed, 0)
  assert.equal(f.state.released, 0)
  assert.equal(f.state.closed, 1)
})

test('missing, deleted, disabled and non-admin accounts are never created or promoted', async (t) => {
  for (const scenario of ['missing', 'deleted', 'disabled', 'member']) {
    await t.test(scenario, async () => {
      const f = await fixture()
      if (scenario === 'missing') f.state.users.shift()
      if (scenario === 'deleted') f.state.users[0].deleted_at = '2026-01-01'
      if (scenario === 'disabled') f.state.users[0].disabled = 1
      // A stale users.role must not override effective role assignments.
      if (scenario === 'member') f.state.assignments = ['member']
      const before = structuredClone(f.state.users)
      await assert.rejects(
        f.reset(),
        /does not exist|enabled, undeleted administrator/,
      )
      assert.deepEqual(f.state.users, before)
      assert.equal(f.state.committed, 0)
      assert.equal(f.state.released, 1)
      assert.equal(f.state.closed, 1)
    })
  }
})

test('lost ownership before mutation or during audit rolls back the whole reset', async (t) => {
  for (const phase of ['initial', 'audit']) {
    await t.test(phase, async () => {
      const f = await fixture({
        initiallyLost: phase === 'initial',
        onQuery(sql, lose) {
          if (
            phase === 'audit' &&
            sql.startsWith('INSERT INTO identity_audit(')
          )
            lose(new Error('synthetic loss'))
        },
      })
      const oldHash = f.state.users[0].password_hash
      await assert.rejects(f.reset(), /ownership was lost/)
      assert.equal(f.state.users[0].password_hash, oldHash)
      assert.equal(f.state.sessions[0].revoked_at, null)
      assert.deepEqual(f.state.recovery, ['synthetic-admin', 'other-user'])
      assert.deepEqual(f.state.audit, [])
      assert.equal(f.state.committed, 0)
      assert.equal(f.state.released, 1)
      assert.equal(f.state.closed, 1)
    })
  }
})

test('audit errors roll back credentials and release errors still close the database', async () => {
  const f = await fixture({
    onQuery(sql) {
      if (sql.startsWith('INSERT INTO identity_audit('))
        throw new Error('synthetic audit failure')
    },
  })
  await assert.rejects(f.reset(), /audit failure/)
  assert.equal(f.state.committed, 0)
  assert.equal(f.state.sessions[0].revoked_at, null)
  assert.equal(f.state.released, 1)
  assert.equal(f.state.closed, 1)
  const releaseFailure = await fixture({ busy: false, failRelease: true })
  await assert.rejects(
    releaseFailure.reset({ username: 'missing' }),
    /release failure/,
  )
  assert.equal(releaseFailure.state.closed, 1)
})

test('CLI requires explicit username and stdin, preserves password spaces and rejects extra input', async () => {
  assert.deepEqual(
    parseResetArguments(['--username', 'Admin', '--password-stdin']),
    { username: 'admin', help: false },
  )
  for (const args of [
    [],
    ['--username', 'admin'],
    ['--password-stdin'],
    ['--username', 'admin', '--password', 'secret'],
    ['--username', 'admin', '--password-stdin', '--password-stdin'],
  ])
    assert.throws(() => parseResetArguments(args))
  assert.equal(
    await readPasswordInput(Readable.from(['  password  \r\n'])),
    '  password  ',
  )
  for (const input of [
    'short',
    'password\nextra',
    'password\u0000',
    'a'.repeat(4099),
  ])
    await assert.rejects(readPasswordInput(Readable.from([input])))
  await assert.rejects(readPasswordInput({ isTTY: true }), /Pipe the password/)
})

test('CLI runs without signing or model keys and never echoes the supplied password', async () => {
  const f = await fixture()
  const logs = []
  const result = await runResetCommand({
    args: ['--username', 'admin', '--password-stdin'],
    input: Readable.from(['synthetic-stdin-password\n']),
    environment: {
      AGENT_SERVER_DB_URL: 'postgresql://synthetic:fixture@localhost/isolated',
    },
    databaseFactory: () => f.database,
    log: (line) => logs.push(line),
    error: (line) => assert.fail(line),
  })
  assert.equal(result, 0)
  assert.equal(
    await f.identity.crypto.verifyPassword(
      'synthetic-stdin-password',
      f.state.users[0].password_hash,
    ),
    true,
  )
  assert.equal(f.state.closed, 1)
  assert.equal(f.state.released, 1)
  assert.doesNotMatch(logs.join('\n'), /synthetic-stdin-password|postgresql:/)
})

test('CLI help touches no database and unexpected failures never print connection or password', async () => {
  const logs = []
  const errors = []
  let connections = 0
  const dependencies = {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    databaseFactory() {
      connections++
      throw new Error(
        'postgresql://admin:private-db-secret@host/db synthetic-new-password',
      )
    },
    environment: {
      AGENT_SERVER_DB_URL: 'postgresql://admin:private-db-secret@host/db',
    },
  }
  assert.equal(await runResetCommand({ ...dependencies, args: ['--help'] }), 0)
  assert.equal(connections, 0)
  assert.equal(
    await runResetCommand({
      ...dependencies,
      args: ['--username', 'admin', '--password-stdin'],
      input: Readable.from(['synthetic-new-password\n']),
    }),
    1,
  )
  assert.equal(connections, 1)
  assert.doesNotMatch(
    [...logs, ...errors].join('\n'),
    /private-db-secret|synthetic-new-password|postgresql:/,
  )
})
