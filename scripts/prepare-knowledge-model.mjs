import { resolve, join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { prepareEmbeddingModel } from '../apps/admin/server/agents/embedding-model.ts'
import { developmentEnvFile } from './server-development.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const devFile = developmentEnvFile(repository)
const saved = existsSync(devFile) ? parseEnv(readFileSync(devFile, 'utf8')) : {}
const home = resolve(
  process.env.SUPERDSH_SERVER_DATA_DIR ||
    saved.SUPERDSH_SERVER_DATA_DIR ||
    join(dirname(devFile), 'native'),
)
const directory =
  process.env.SUPERDSH_EMBEDDING_MODEL_DIR ||
  join(home, 'models', 'bge-small-zh-v1.5')
await prepareEmbeddingModel(directory)
console.log(`Knowledge embedding model prepared: ${directory}`)
