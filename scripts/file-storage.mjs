import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { developmentEnvironment } from './server-development.mjs'
import { deploymentEnvironment } from '../apps/admin/deployment/bootstrap.mjs'
import { serverConfiguration } from '../apps/admin/server/infrastructure/configuration.ts'
import { createDatabase } from '../apps/admin/server/infrastructure/database.ts'
import { schemaRevision } from '../apps/admin/server/infrastructure/schema.ts'
import { StorageRegistry } from '../apps/admin/server/files/storage-registry.ts'
import { FileLibrary } from '../apps/admin/server/files/file-library.ts'
import {
  importLegacyFileContents,
  collectFileGarbage,
} from '../apps/admin/server/files/maintenance.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2),
  apply = args.includes('--apply')
if (
  args.some(
    (arg) =>
      !['--apply', '--cleanup', '--production'].includes(arg) &&
      !arg.startsWith('--target='),
  )
)
  throw new Error(
    'Usage: server:files [--apply] [--target=storage-id] [--cleanup] [--production]',
  )
const environment = args.includes('--production')
  ? await deploymentEnvironment()
  : developmentEnvironment(root)
const config = serverConfiguration(environment),
  db = createDatabase(config.databaseUrl)
const registry = new StorageRegistry({
  db,
  root: config.filesDirectory,
  encryptionKey: config.encryptionKey,
  environment,
})
const library = new FileLibrary({
  db,
  registry,
  stagingDirectory: join(config.dataDirectory, 'file-uploads'),
})
let lease
try {
  const [version] = await db.query('SELECT version_num FROM alembic_version')
  if (version?.version_num !== schemaRevision)
    throw new Error('Run server:migrate before file maintenance.')
  lease = await db.lease('superdsh:platform-api')
  if (!lease)
    throw new Error(
      'Stop the Node platform before file maintenance; no files were changed.',
    )
  const controller = new AbortController()
  void lease.lost.then((error) => controller.abort(error))
  console.log(
    apply
      ? 'Applying resumable file maintenance; original sources remain preserved.'
      : 'Checking inventory only; no file content is moved or deleted.',
  )
  if (args.includes('--cleanup'))
    console.log(await collectFileGarbage(library, apply, controller.signal))
  else {
    console.log(
      await importLegacyFileContents(library, apply, controller.signal),
    )
    const target = args.find((arg) => arg.startsWith('--target='))?.slice(9)
    if (target) {
      let cursor = '',
        count = 0
      while (true) {
        const entry = await library.nextMigrationEntry(cursor)
        if (!entry) break
        cursor = entry.id
        count++
        if (apply)
          await library.migrate(
            entry.owner_user_id,
            entry.id,
            target,
            controller.signal,
          )
      }
      console.log({ target, files: count, switched: apply })
    }
  }
} finally {
  registry.close()
  await lease?.release()
  await db.close()
}
