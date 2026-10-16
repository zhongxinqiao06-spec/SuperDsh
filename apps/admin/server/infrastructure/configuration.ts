import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ServerConfiguration {
  databaseUrl: string
  redisUrl: string
  qdrantUrl?: string
  qdrantApiKey?: string
  secret: string
  encryptionKey: string
  dataDirectory: string
  filesDirectory: string
  hostname: string
  port: number
  apiPort: number
  origins: string[]
  setupToken?: string
  dev: boolean
}

const repository = fileURLToPath(new URL('../../../../', import.meta.url))

export function serverConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfiguration {
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value)
      throw new Error(
        `${name} is required; keep the original database credentials and encryption key`,
      )
    return value
  }
  const port = (name: string, fallback: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isInteger(value) || value < 0 || value > 65535)
      throw new Error(`${name} must be a valid TCP port`)
    return value
  }
  const dataDirectory = resolve(
    env.SUPERDSH_SERVER_DATA_DIR ||
      resolve(repository, '.superdsh-work/server-native'),
  )
  const databaseUrl = required('AGENT_SERVER_DB_URL').replace(
    /^postgresql\+asyncpg:/,
    'postgresql:',
  )
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error('Node platform requires PostgreSQL')
  const redisUrl = required('AGENT_SERVER_REDIS_URL')
  if (!/^rediss?:\/\//.test(redisUrl))
    throw new Error('A Redis URL is required')
  const secret = required('AGENT_SERVER_SECRET')
  const qdrantUrl = env.SUPERDSH_QDRANT_URL?.trim()
  if (qdrantUrl) {
    const parsed = new URL(qdrantUrl)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        'SUPERDSH_QDRANT_URL must be an HTTP(S) endpoint without credentials, query or fragment',
      )
  }
  const encryptionKey = required('SUPERDSH_MODEL_ENCRYPTION_KEY')
  if (Buffer.from(encryptionKey, 'base64url').length !== 32)
    throw new Error('SUPERDSH_MODEL_ENCRYPTION_KEY must encode 32 bytes')
  return {
    databaseUrl,
    redisUrl,
    qdrantUrl,
    qdrantApiKey: env.SUPERDSH_QDRANT_API_KEY?.trim() || undefined,
    secret,
    encryptionKey,
    dataDirectory,
    filesDirectory: resolve(
      env.AGENT_SERVER_FILES_LOCAL_ROOT || resolve(dataDirectory, 'files'),
    ),
    hostname: env.SUPERDSH_SERVER_HOST || '127.0.0.1',
    port: port('SUPERDSH_SERVER_PORT', 5174),
    apiPort: port('AGENT_SERVER_PORT', 8000),
    origins: (
      env.AGENT_SERVER_CORS_ORIGINS ||
      'http://127.0.0.1:5174,http://localhost:5174'
    )
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    setupToken: env.AGENT_SERVER_SETUP_TOKEN,
    dev: env.NODE_ENV !== 'production',
  }
}
