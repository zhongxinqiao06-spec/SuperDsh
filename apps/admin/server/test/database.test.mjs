import assert from 'node:assert/strict'
import test from 'node:test'
import { withTestDatabase } from './support/database.mjs'
import { ensureSchema } from '../infrastructure/schema.ts'

const integration = process.env.SUPERDSH_NODE_TEST_DATABASE_URL
  ? {}
  : { skip: 'isolated PostgreSQL runner required' }

test(
  'PostgreSQL schema initializes all legacy tables and reuses its revision',
  integration,
  async (t) => {
    const db = await withTestDatabase(t)
    const before = await db.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=current_schema()',
    )
    assert.equal(before.length, 43)
    await db.query(
      "INSERT INTO instance_settings (key,value,updated_at) VALUES ('compatibility-test','preserve-me','2026-10-15T00:00:00Z')",
    )
    await ensureSchema(db)
    assert.equal(
      (
        await db.query(
          "SELECT value FROM instance_settings WHERE key='compatibility-test'",
        )
      )[0].value,
      'preserve-me',
      '2026-10-15T00:00:00Z',
    )
    assert.deepEqual(
      await db.query('SELECT version_num FROM alembic_version'),
      [{ version_num: 'v2_42' }],
    )
  },
)

test(
  'transaction rollback does not leak writes into the next pooled request',
  integration,
  async (t) => {
    const db = await withTestDatabase(t)
    await assert.rejects(
      db.transaction(async (connection) => {
        await connection.query(
          "INSERT INTO instance_settings (key,value,updated_at) VALUES ('rolled-back','x','2026-10-15T00:00:00Z')",
        )
        throw new Error('cancel operation')
      }),
      /cancel operation/,
    )
    assert.equal(
      (
        await db.query(
          "SELECT * FROM instance_settings WHERE key='rolled-back'",
        )
      ).length,
      0,
    )
    await db.transaction((connection) =>
      connection.query(
        "INSERT INTO instance_settings (key,value,updated_at) VALUES ('committed','x','2026-10-15T00:00:00Z')",
      ),
    )
    assert.equal(
      (await db.query("SELECT * FROM instance_settings WHERE key='committed'"))
        .length,
      1,
    )
  },
)

test(
  'schema mismatch fails without stamping an incompatible existing database',
  integration,
  async (t) => {
    const db = await withTestDatabase(t)
    await db.query("UPDATE alembic_version SET version_num='future_version'")
    await assert.rejects(ensureSchema(db), /Unsupported database revision/)
    assert.equal(
      (await db.query('SELECT version_num FROM alembic_version'))[0]
        .version_num,
      'future_version',
    )
  },
)

test(
  'database ownership stays exclusive until release and reports a lost connection',
  integration,
  async (t) => {
    const db = await withTestDatabase(t)
    const lease = await db.lease('native-platform')
    assert.ok(lease)
    assert.equal(await db.lease('native-platform'), null)
    await lease.release()
    const next = await db.lease('native-platform')
    assert.ok(next)
    const locks = await db.query(
      "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND a.datname=current_database() AND l.pid<>pg_backend_pid()",
    )
    assert.equal(locks.length, 1)
    await db.query('SELECT pg_terminate_backend($1)', [locks[0].pid])
    const lost = await Promise.race([
      next.lost,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('lost ownership was not reported')),
          2000,
        ).unref(),
      ),
    ])
    assert.ok(lost instanceof Error)
    await next.release()
    const final = await db.lease('native-platform')
    assert.ok(final)
    await final.release()
  },
)

for (const [table, column] of [
  ['business_agent_assets', 'content'],
  ['sessions', 'agent_definition_json'],
  ['business_knowledge_bases', 'definition_json'],
  ['business_agent_skills', 'enabled'],
  ['business_agent_tools', 'version'],
])
  test(
    `current schema rejects missing ${table}.${column} without silently repairing data`,
    integration,
    async (t) => {
      const db = await withTestDatabase(t)
      await db.query(`ALTER TABLE ${table} DROP COLUMN ${column}`)
      await assert.rejects(ensureSchema(db), (error) =>
        error.message.includes(`${table}.${column}`),
      )
      assert.equal(
        (await db.query('SELECT version_num FROM alembic_version'))[0]
          .version_num,
        'v2_42',
      )
      assert.equal(
        (
          await db.query(
            'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2',
            [table, column],
          )
        ).length,
        0,
      )
    },
  )
