import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { developmentEnvironment } from './server-development.mjs'
import { serverConfiguration } from '../apps/admin/server/infrastructure/configuration.ts'
import { createDatabase } from '../apps/admin/server/infrastructure/database.ts'
import { schemaRevision } from '../apps/admin/server/infrastructure/schema.ts'
import { ModelService } from '../apps/admin/server/models/model-service.ts'
import { ModelConfigurationService } from '../apps/admin/server/models/configuration-service.ts'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--apply' && !arg.startsWith('--file=')))
  throw new Error(
    'Usage: server:models:init [--apply] [--file=absolute-private-json]',
  )
const file =
  args.find((arg) => arg.startsWith('--file='))?.slice(7) ||
  join(root, '.superdsh-work/server-dev/model-initialization.json')
const source = JSON.parse(await readFile(file, 'utf8'))
if (source.schemaVersion !== 1)
  throw new Error('Unsupported model initialization format')
const config = serverConfiguration(developmentEnvironment(root))
const db = createDatabase(config.databaseUrl)
let lease
try {
  if (
    (await db.query('SELECT version_num FROM alembic_version'))[0]
      ?.version_num !== schemaRevision
  )
    throw new Error(
      'Migrate the platform before importing model configuration.',
    )
  lease = await db.lease('superdsh:platform-api')
  if (!lease)
    throw new Error(
      'Stop the platform before initializing models. No configuration was changed.',
    )
  const models = new ModelService({
    db,
    encryptionKey: config.encryptionKey,
    audit: async () => {},
  })
  const configurations = new ModelConfigurationService({
    db,
    encryptionKey: config.encryptionKey,
  })
  let preserved = 0,
    created = 0
  for (const provider of source.deepseek || []) {
    const owner = provider.ownerUserId || null
    if (
      owner &&
      !(await db.query('SELECT id FROM users WHERE id=$1', [owner])).length
    )
      throw new Error(
        'Personal seed owner is missing. Do not promote a personal key to platform scope.',
      )
    const existing = await db.query(
      'SELECT id FROM platform_model_providers WHERE owner_user_id IS NOT DISTINCT FROM $1 AND (id=$2 OR (base_url=$3 AND name=$4))',
      [owner, provider.sourceProviderId, provider.baseUrl, provider.name],
    )
    if (existing.length) {
      preserved++
      continue
    }
    if (args.includes('--apply'))
      await models.save(provider, owner || 'model-initialization', owner)
    created++
  }
  if (source.ark?.apiKey) {
    const endpoint =
      source.ark.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3'
    const existing = await db.query(
      "SELECT id FROM model_connections WHERE owner_user_id IS NULL AND adapter='volcengine-ark' AND base_url=$1",
      [endpoint],
    )
    if (existing.length) preserved++
    else {
      if (args.includes('--apply'))
        await configurations.saveConnection(undefined, {
          name: source.ark.name || '火山方舟',
          adapter: 'volcengine-ark',
          baseUrl: endpoint,
          apiKey: source.ark.apiKey,
        })
      created++
    }
  }
  console.log({
    mode: args.includes('--apply') ? 'applied' : 'check-only',
    existingPreserved: preserved,
    newConnections: created,
  })
  console.log(
    'No default changed. Configure authorized model IDs in model management; keys are never printed.',
  )
} finally {
  await lease?.release()
  await db.close()
}
