import { readFile } from 'node:fs/promises'
import type { Database, SqlConnection } from './database.ts'
import { migrateProductSchema } from './migrations.ts'

export const schemaRevision = 'v2_42'
export const schemaVersion = '2.42'
const migrationLock = BigInt('0x414147454E545332').toString()

/** Never replace a populated database with an empty Node-owned database. */
export async function ensureSchema(db: Database): Promise<void> {
  const ddl = (
    await Promise.all(
      ['./schema-v2-39.sql', './schema-v2-40.sql', './schema-v2-41.sql'].map(
        (file) => readFile(new URL(file, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n')
  await db.transaction(async (connection) => {
    await connection.query("SET LOCAL lock_timeout = '120s'")
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      migrationLock,
    ])
    const tables = await connection.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
    )
    if (!tables.length) {
      await connection.query(ddl)
      await connection.query(
        'CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)',
      )
      await connection.query(
        'INSERT INTO alembic_version (version_num) VALUES ($1)',
        [schemaRevision],
      )
      return
    }
    if (!tables.some((table) => table.tablename === 'alembic_version'))
      throw new Error(
        'The existing database has no schema revision; refusing to overwrite it',
      )
    const versions = await connection.query<{ version_num: string }>(
      'SELECT version_num FROM alembic_version',
    )
    if (versions.length !== 1 || !versions[0]?.version_num)
      throw new Error(
        'Existing database has an ambiguous schema revision; refusing to overwrite it',
      )
    if (versions[0].version_num !== schemaRevision)
      await migrateProductSchema(connection, versions[0].version_num, ddl)
    await validateCurrentSchema(connection, ddl)
  })
}

async function validateCurrentSchema(
  connection: SqlConnection,
  ddl: string,
): Promise<void> {
  const required = [...ddl.matchAll(/CREATE TABLE (\w+)\s*\(/g)].map(
    (match) => match[1]!,
  )
  const existing = await connection.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()',
  )
  const names = new Set(existing.map((row) => row.table_name))
  const missing = required.filter((name) => !names.has(name))
  if (missing.length)
    throw new Error(`Existing schema is incomplete: ${missing.join(', ')}`)
  const columns = await connection.query<{
    table_name: string
    column_name: string
  }>(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()',
  )
  const columnNames = new Set(
    columns.map((column) => `${column.table_name}.${column.column_name}`),
  )
  const missingColumns: string[] = []
  for (const match of ddl.matchAll(/CREATE TABLE (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    for (const column of match[2]!.matchAll(
      /^\s*(\w+)\s+(TEXT|INTEGER|BIGINT|BOOLEAN|FLOAT|DOUBLE|VARCHAR|BYTEA)/gm,
    )) {
      const name = `${match[1]}.${column[1]}`
      if (!columnNames.has(name)) missingColumns.push(name)
    }
  }
  for (const [, table, column] of ddl.matchAll(
    /ALTER TABLE (\w+) ADD COLUMN (\w+)/g,
  )) {
    const name = `${table}.${column}`
    if (!columnNames.has(name)) missingColumns.push(name)
  }
  if (missingColumns.length)
    throw new Error(
      `Existing schema is incomplete: ${missingColumns.join(', ')}`,
    )
}
