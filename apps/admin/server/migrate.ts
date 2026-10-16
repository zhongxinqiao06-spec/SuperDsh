import { pathToFileURL } from 'node:url'
import { createDatabase } from './infrastructure/database.ts'
import { serverConfiguration } from './infrastructure/configuration.ts'
import { ensureSchema } from './infrastructure/schema.ts'
import { IdentityService } from './identity/service.ts'

export async function migrate(): Promise<void> {
  const configuration = serverConfiguration()
  const db = createDatabase(configuration.databaseUrl)
  try {
    await ensureSchema(db)
    const identity = new IdentityService(db, { secret: configuration.secret })
    await identity.seedBuiltinRoles()
    if (
      process.env.SUPERDSH_BOOTSTRAP_DEV_ADMIN === '1' &&
      !(await db.query('SELECT id FROM users LIMIT 1')).length
    )
      await identity.createUser(
        { username: 'admin', displayName: 'admin', password: 'admin123' },
        { role: 'admin', bootstrap: true },
      )
    console.log(
      'Node database schema and builtin roles are current; existing credentials retained.',
    )
  } finally {
    await db.close()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await migrate().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Database migration failed',
    )
    process.exitCode = 1
  })
