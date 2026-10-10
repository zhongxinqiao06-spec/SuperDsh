import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

export function prepareDevelopmentAgentEnv(root, environment = process.env) {
  const file = developmentEnvFile(root, environment)
  const saved = parseEnv(readFileSync(file, 'utf8'))
  if (
    !saved.SUPERDSH_AGENT_SUPERVISOR_SECRET &&
    !environment.SUPERDSH_AGENT_SUPERVISOR_SECRET
  ) {
    appendFileSync(
      file,
      `\nSUPERDSH_AGENT_SUPERVISOR_SECRET=${randomBytes(32).toString('base64url')}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }
  return developmentEnvironment(root, environment)
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
  const agentPort = port(
    settings.SUPERDSH_DEV_AGENT_PORT || '18090',
    'SUPERDSH_DEV_AGENT_PORT',
  )
  const managedDatabase = !settings.AGENT_SERVER_DB_URL
  const apiPort = port(
    settings.AGENT_SERVER_PORT || '8000',
    'AGENT_SERVER_PORT',
  )
  const enableAgent =
    managedDatabase && settings.SUPERDSH_DEV_AGENT_ENABLED !== '0'
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
    // Only the database created by our local dependency command gets a known
    // development login. An explicit database URL may point at real user data.
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: settings.AGENT_SERVER_DB_URL ? '0' : '1',
    SUPERDSH_DEV_AGENT_ENABLED: enableAgent ? '1' : '0',
    SUPERDSH_DEV_AGENT_PORT: agentPort,
    AGENT_SERVER_PORT: apiPort,
    ...(enableAgent
      ? {
          SUPERDSH_AGENT_SUPERVISOR_URL: `http://127.0.0.1:${agentPort}`,
          SUPERDSH_AGENT_SERVER_URL: 'http://server-next:8000',
        }
      : {}),
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
    PYTHONUTF8: '1',
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
    join(root, 'apps/server/docker/compose.dev.yml'),
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
