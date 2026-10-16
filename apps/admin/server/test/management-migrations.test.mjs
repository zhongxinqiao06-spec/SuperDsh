import assert from 'node:assert/strict'
import test from 'node:test'
import { withTestDatabase } from './support/database.mjs'
import { ensureSchema } from '../infrastructure/schema.ts'
import { IdentityService } from '../identity/service.ts'

async function oldSchema(t, revision) {
  const db = await withTestDatabase(t),
    identity = new IdentityService(db, { secret: 'synthetic-migration-secret' })
  await identity.seedBuiltinRoles()
  const user = await identity.createUser(
    {
      username: 'admin',
      email: 'admin@example.test',
      displayName: 'Admin',
      password: 'synthetic-old-password',
    },
    { role: 'admin', trustEmail: true },
  )
  const original = (
    await db.query('SELECT * FROM users WHERE id=$1', [user.userId])
  )[0]
  const now = new Date().toISOString()
  await db.query(
    "INSERT INTO connectors(id,user_id,name,status,token_hash,token_prefix,created_at,updated_at) VALUES('old_connector',$1,'Old device','offline','synthetic-old-key','prefix',$2,$2)",
    [user.userId, now],
  )
  for (const table of [
    'business_knowledge_bases',
    'business_agent_skills',
    'business_agent_tools',
    'business_agent_artifacts',
    'business_agent_sessions',
    'business_agents',
    'business_agent_assets',
  ])
    await db.query(`DROP TABLE ${table}`)
  await db.query('ALTER TABLE sessions DROP COLUMN agent_definition_json')
  await db.query('DROP TABLE navigation_settings')
  await db.query(
    'UPDATE roles SET permissions_json=\'["users.read","users.manage","roles.manage"]\' WHERE id=\'admin\'',
  )
  if (revision < 38) {
    await db.query('DROP TABLE server_agents')
    await db.query('ALTER TABLE connectors DROP COLUMN executor_kind')
    await db.query(
      'ALTER TABLE platform_model_providers DROP COLUMN owner_user_id',
    )
  }
  if (revision < 37) {
    await db.query('DROP TABLE platform_model_providers')
    await db.query('DROP TABLE platform_model_defaults')
  } else
    await db.query(
      "INSERT INTO platform_model_providers(id,name,protocol,base_url,key_ciphertext,models_json,created_at,updated_at) VALUES('old-provider','DeepSeek','openai-completions','https://api.deepseek.com','synthetic-preserved-cipher','[]',$1,$1)",
      [now],
    )
  if (revision < 36) {
    for (const table of [
      'user_roles',
      'auth_sessions',
      'recovery_codes',
      'identity_audit',
      'roles',
    ])
      await db.query(`DROP TABLE ${table}`)
    await db.query(
      'ALTER TABLE users DROP COLUMN username,DROP COLUMN auth_version,DROP COLUMN deleted_at,DROP COLUMN deleted_by,DROP COLUMN reset_required',
    )
    await db.query(
      'ALTER TABLE connectors DROP COLUMN connection_blocked_at,DROP COLUMN connection_blocked_by,DROP COLUMN connection_blocked_reason,DROP COLUMN connector_version',
    )
  }
  await db.query('UPDATE alembic_version SET version_num=$1', [
    `v2_${revision}`,
  ])
  return { db, identity, user, original }
}

for (const revision of [35, 36, 37, 38])
  test(`Node upgrades product v2_${revision} without changing owner IDs, password hashes or model ciphertext`, async (t) => {
    const f = await oldSchema(t, revision)
    await ensureSchema(f.db)
    assert.equal(
      (await f.db.query('SELECT version_num FROM alembic_version'))[0]
        .version_num,
      'v2_42',
    )
    const user = (
      await f.db.query('SELECT * FROM users WHERE id=$1', [f.user.userId])
    )[0]
    assert.equal(user.password_hash, f.original.password_hash)
    assert.equal(user.email, f.original.email)
    assert.ok(user.username)
    const connector = (
      await f.db.query("SELECT * FROM connectors WHERE id='old_connector'")
    )[0]
    assert.equal(connector.user_id, f.user.userId)
    assert.equal(connector.token_hash, 'synthetic-old-key')
    assert.equal(connector.executor_kind, 'desktop')
    assert.ok(
      (await f.identity.getUser(f.user.userId)).permissions.includes(
        'menus.manage',
      ),
    )
    assert.ok(
      (await f.identity.getUser(f.user.userId)).permissions.includes(
        'agents.manage',
      ),
    )
    assert.equal(
      (
        await f.db.query(
          "SELECT version FROM navigation_settings WHERE id='global'",
        )
      )[0].version,
      1,
    )
    if (revision >= 37)
      assert.equal(
        (
          await f.db.query(
            "SELECT key_ciphertext FROM platform_model_providers WHERE id='old-provider'",
          )
        )[0].key_ciphertext,
        'synthetic-preserved-cipher',
      )
    await ensureSchema(f.db)
    assert.equal((await f.db.query('SELECT count(*) FROM users'))[0].count, '1')
  })

test('orphan ownership rejects and rolls back migration rather than assigning an administrator', async (t) => {
  const f = await oldSchema(t, 35)
  await f.db.query(
    "UPDATE connectors SET user_id='nonexistent' WHERE id='old_connector'",
  )
  await assert.rejects(ensureSchema(f.db), /without an existing owner/)
  assert.equal(
    (await f.db.query('SELECT version_num FROM alembic_version'))[0]
      .version_num,
    'v2_35',
  )
  assert.equal(
    (
      await f.db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name='roles'",
      )
    ).length,
    0,
  )
})

test('pre-product or damaged schemas fail explicitly without advancing revision', async (t) => {
  const db = await withTestDatabase(t)
  await db.query("UPDATE alembic_version SET version_num='v2_34'")
  await assert.rejects(ensureSchema(db), /upgrade pre-product databases/)
  assert.equal(
    (await db.query('SELECT version_num FROM alembic_version'))[0].version_num,
    'v2_34',
  )
  await db.query("UPDATE alembic_version SET version_num='v2_42'")
  await db.query('ALTER TABLE users DROP COLUMN avatar')
  await assert.rejects(ensureSchema(db), /users.avatar/)
})
