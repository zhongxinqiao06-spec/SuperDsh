import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

export function developmentEnvFile(root, environment = process.env) {
  return environment.SUPERDSH_SERVER_DEV_ENV
    ? resolve(root, environment.SUPERDSH_SERVER_DEV_ENV)
    : join(root, '.superdsh-work/server-dev/aa-dev.env')
}

export function prepareDevelopmentEnv(root, environment = process.env) {
  const file = developmentEnvFile(root, environment)
  if (existsSync(file)) return file
  if (environment.SUPERDSH_SERVER_DEV_ENV)
    throw new Error(`Development env file does not exist: ${file}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    [
      '# Local development only; keep this file with its database volumes.',
      `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
      'SUPERDSH_DEV_PG_PORT=15432',
      'SUPERDSH_DEV_REDIS_PORT=16379',
      'SUPERDSH_DEV_QDRANT_PORT=16333',
      `AGENT_SERVER_SECRET=${randomBytes(32).toString('hex')}`,
      `SUPERDSH_MODEL_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}=`,
      'AGENT_SERVER_PUBLIC_ORIGIN=http://127.0.0.1:5174',
      'AGENT_SERVER_CORS_ORIGINS=http://127.0.0.1:5174,http://localhost:5174',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  )
  return file
}

export function persistDevelopmentPorts(
  root,
  ports,
  environment = process.env,
) {
  const file = developmentEnvFile(root, environment)
  const original = readFileSync(file, 'utf8')
  let updated = original
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  for (const name of [
    'SUPERDSH_DEV_PG_PORT',
    'SUPERDSH_DEV_REDIS_PORT',
    'SUPERDSH_DEV_QDRANT_PORT',
  ]) {
    const value = port(ports[name], name)
    const entry = new RegExp(
      `^([ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=)[^\\r\\n]*`,
      'gm',
    )
    if (entry.test(updated))
      updated = updated.replace(entry, (_match, prefix) => `${prefix}${value}`)
    else
      updated += `${updated.endsWith('\n') ? '' : newline}${name}=${value}${newline}`
  }
  if (updated === original) return file
  // Replace atomically so a failed write cannot truncate persisted credentials.
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, updated, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return file
}

function port(value, name) {
  if (!/^\d+$/u.test(String(value)) || +value < 1 || +value > 65535)
    throw new Error(`${name} must be a port from 1 to 65535`)
  return String(+value)
}

export function developmentEnvironment(root, environment = process.env) {
  const externalDatabase = Boolean(environment.AGENT_SERVER_DB_URL)
  const externalRedis = Boolean(environment.AGENT_SERVER_REDIS_URL)
  if (externalDatabase !== externalRedis)
    throw new Error(
      'Set both AGENT_SERVER_DB_URL and AGENT_SERVER_REDIS_URL, or neither for the local development containers.',
    )
  const file = developmentEnvFile(root, environment)
  if (!existsSync(file) && !externalDatabase)
    throw new Error(
      'Development dependencies are not configured. Run corepack.cmd yarn server:deps:up first, or set both AGENT_SERVER_DB_URL and AGENT_SERVER_REDIS_URL.',
    )
  if (!existsSync(file)) prepareDevelopmentEnv(root, environment)
  const saved = parseEnv(readFileSync(file, 'utf8'))
  const settings = { ...saved, ...environment }
  const pgPort = port(
    settings.SUPERDSH_DEV_PG_PORT || '15432',
    'SUPERDSH_DEV_PG_PORT',
  )
  const redisPort = port(
    settings.SUPERDSH_DEV_REDIS_PORT || '16379',
    'SUPERDSH_DEV_REDIS_PORT',
  )
  const apiPort = port(
    settings.AGENT_SERVER_PORT || '8000',
    'AGENT_SERVER_PORT',
  )
  const qdrantPort = port(
    settings.SUPERDSH_DEV_QDRANT_PORT || '16333',
    'SUPERDSH_DEV_QDRANT_PORT',
  )
  if (!settings.POSTGRES_PASSWORD && !externalDatabase)
    throw new Error(
      'POSTGRES_PASSWORD is missing from the development env file',
    )
  if (!settings.AGENT_SERVER_SECRET || !settings.SUPERDSH_MODEL_ENCRYPTION_KEY)
    throw new Error(
      'Development env file is missing its persistent authentication or model encryption key',
    )
  return {
    ...settings,
    SUPERDSH_DEV_PG_PORT: pgPort,
    SUPERDSH_DEV_REDIS_PORT: redisPort,
    SUPERDSH_DEV_QDRANT_PORT: qdrantPort,
    SUPERDSH_QDRANT_URL:
      settings.SUPERDSH_QDRANT_URL || `http://127.0.0.1:${qdrantPort}`,
    // Only the database created by our local dependency command gets a known
    // development login. An explicit database URL may point at real user data.
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: settings.AGENT_SERVER_DB_URL ? '0' : '1',
    SUPERDSH_NATIVE_PLATFORM: '1',
    SUPERDSH_SERVER_DATA_DIR:
      settings.SUPERDSH_SERVER_DATA_DIR || join(dirname(file), 'native'),
    AGENT_SERVER_PORT: apiPort,
    // Ignore retired Supervisor addresses without rewriting the saved env file.
    SUPERDSH_AGENT_SUPERVISOR_URL: '',
    SUPERDSH_AGENT_SUPERVISOR_SECRET: '',
    SUPERDSH_AGENT_SERVER_URL: '',
    AGENT_SERVER_DB_BACKEND: 'postgres',
    AGENT_SERVER_DB_URL:
      settings.AGENT_SERVER_DB_URL ||
      `postgresql+asyncpg://agents_anywhere:${encodeURIComponent(settings.POSTGRES_PASSWORD)}@127.0.0.1:${pgPort}/agents_anywhere`,
    AGENT_SERVER_REDIS_URL:
      settings.AGENT_SERVER_REDIS_URL || `redis://127.0.0.1:${redisPort}/0`,
    AGENT_SERVER_FILES_BACKEND: settings.AGENT_SERVER_FILES_BACKEND || 'local',
    AGENT_SERVER_FILES_LOCAL_ROOT:
      settings.AGENT_SERVER_FILES_LOCAL_ROOT ||
      join(dirname(file), 'agent-server.files'),
    AGENT_SERVER_PUBLIC_ORIGIN:
      settings.AGENT_SERVER_PUBLIC_ORIGIN || 'http://127.0.0.1:5174',
    AGENT_SERVER_CORS_ORIGINS:
      settings.AGENT_SERVER_CORS_ORIGINS ||
      'http://127.0.0.1:5174,http://localhost:5174',
  }
}

export function developmentComposeArgs(root, file) {
  return [
    'compose',
    '--project-name',
    'superdsh-dev',
    '--env-file',
    file,
    '--file',
    join(root, 'apps/admin/deployment/compose.dependencies.yml'),
  ]
}

export function verifyDevelopmentDatabaseContainer(container, environment) {
  const target = new URL(environment.AGENT_SERVER_DB_URL)
  const labels = container?.Config?.Labels
  const ports = container?.NetworkSettings?.Ports?.['5432/tcp'] ?? []
  if (
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/agents_anywhere' ||
    !container?.State?.Running ||
    labels?.['com.docker.compose.project'] !== 'superdsh-dev' ||
    labels?.['com.docker.compose.service'] !== 'postgres' ||
    !ports.some(
      (binding) =>
        binding.HostIp === '127.0.0.1' && binding.HostPort === target.port,
    )
  ) {
    throw new Error(
      'Default admin initialization requires the running superdsh-dev PostgreSQL container on its configured loopback port. Run server:deps:up, or use an explicit AGENT_SERVER_DB_URL for an external database.',
    )
  }
}
