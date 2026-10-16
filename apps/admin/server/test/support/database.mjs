import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createDatabase } from '../../infrastructure/database.ts'
import { ensureSchema } from '../../infrastructure/schema.ts'

/** Dedicated integration container only; never use the application's DB settings. */
export async function withTestDatabase(t) {
  const configured = process.env.SUPERDSH_NODE_TEST_DATABASE_URL
  if (!configured)
    throw new Error(
      'Run the isolated Node integration test runner to provide PostgreSQL',
    )
  const url = new URL(configured)
  if (
    url.pathname !== '/superdsh_node_test' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  )
    throw new Error(
      'Only the isolated loopback superdsh_node_test database is allowed',
    )
  const admin = new pg.Client({ connectionString: url.href })
  await admin.connect()
  const name = `test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = `/${name}`
  const db = createDatabase(url.href)
  Object.defineProperty(db, 'testUrl', { value: url.href })
  t.after(async () => {
    await db.close()
    try {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })
  await ensureSchema(db)
  return db
}
