import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const secretNames = ['AGENT_SERVER_SECRET', 'SUPERDSH_MODEL_ENCRYPTION_KEY']

async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writePrivateFile(path, content) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    // Linking publishes a complete file without ever replacing an existing one.
    await link(temporary, path)
  } finally {
    await unlink(temporary)
  }
}

function environmentLine(name, value) {
  for (const quote of ["'", '"', '`', '']) {
    const line = `${name}=${quote}${value}${quote}`
    if (parseEnv(line)[name] === value) return line
  }
  throw new Error(`${name} cannot be saved as an environment value`)
}

export async function deploymentEnvironment(environment = process.env) {
  const root = resolve(environment.SUPERDSH_DEPLOYMENT_DATA_DIR || '/data')
  const result = {
    ...environment,
    NODE_ENV: 'production',
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: '0',
    SUPERDSH_SERVER_HOST: environment.SUPERDSH_SERVER_HOST || '0.0.0.0',
    SUPERDSH_SERVER_PORT: environment.SUPERDSH_SERVER_PORT || '5174',
    AGENT_SERVER_PORT: environment.AGENT_SERVER_PORT || '8000',
    SUPERDSH_SERVER_DATA_DIR:
      environment.SUPERDSH_SERVER_DATA_DIR || resolve(root, 'runtime'),
    AGENT_SERVER_FILES_LOCAL_ROOT:
      environment.AGENT_SERVER_FILES_LOCAL_ROOT || resolve(root, 'files'),
    SUPERDSH_DEPLOYMENT_CONFIG_DIR:
      environment.SUPERDSH_DEPLOYMENT_CONFIG_DIR || resolve(root, 'config'),
  }
  if (!result.AGENT_SERVER_DB_URL?.trim()) {
    const password =
      environment.POSTGRES_PASSWORD ||
      (
        await readFile(
          environment.POSTGRES_PASSWORD_FILE ||
            resolve(root, 'config/postgres-password'),
          'utf8',
        )
      ).trim()
    if (!password) throw new Error('PostgreSQL password file is empty')
    const username = environment.POSTGRES_USER || 'agents_anywhere'
    const database = environment.POSTGRES_DB || 'agents_anywhere'
    const host = environment.POSTGRES_HOST || 'postgres'
    const port = environment.POSTGRES_PORT || '5432'
    result.AGENT_SERVER_DB_URL = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`
  }
  return result
}

export async function bootstrapDeployment({
  environment,
  database,
  initializeIdentity,
  log = console.log,
}) {
  const configDirectory = environment.SUPERDSH_DEPLOYMENT_CONFIG_DIR
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const configurationPath = resolve(configDirectory, 'platform.env')
  const credentialsPath = resolve(configDirectory, 'initial-admin.txt')
  const ownership = await database.lease('superdsh:platform-api')
  if (!ownership)
    throw new Error(
      'Another platform owns this database; stop it before initializing this deployment',
    )
  let ownershipLost = false
  void ownership.lost.then(() => {
    ownershipLost = true
  })
  const checkOwnership = () => {
    if (ownershipLost) throw new Error('Database ownership lost during setup')
  }
  try {
    const savedText = await optionalFile(configurationPath)
    const saved = savedText === null ? {} : parseEnv(savedText)
    const [state] = await database.query(
      `SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
      ) AS populated`,
    )
    const result = { ...environment }
    for (const name of secretNames) {
      const supplied = environment[name]?.trim()
      const retained = saved[name]?.trim()
      if (savedText !== null && !retained)
        throw new Error(
          `${name} is missing from saved platform.env; restore the original configuration`,
        )
      if (retained && supplied && retained !== supplied)
        throw new Error(
          `${name} differs from saved platform.env; keep the original deployment key`,
        )
      if (!retained && !supplied && state?.populated)
        throw new Error(
          `${name} is required for an existing database; restore the original deployment key`,
        )
      result[name] =
        retained || supplied || randomBytes(32).toString('base64url')
    }
    if (
      Buffer.from(result.SUPERDSH_MODEL_ENCRYPTION_KEY, 'base64url').length !==
      32
    )
      throw new Error('SUPERDSH_MODEL_ENCRYPTION_KEY must encode 32 bytes')
    checkOwnership()
    if (savedText === null)
      await writePrivateFile(
        configurationPath,
        '# Generated once. Back up this file together with the database.\n' +
          secretNames
            .map((name) => environmentLine(name, result[name]))
            .join('\n') +
          '\n',
      )
    await chmod(configurationPath, 0o600)
    const identity = await initializeIdentity(result)
    checkOwnership()
    const users = await database.query('SELECT id FROM users LIMIT 1')
    if (users.length) {
      log(
        'Existing platform accounts retained; no administrator password was changed.',
      )
      return result
    }

    const savedCredentials = await optionalFile(credentialsPath)
    let credentials
    if (savedCredentials !== null) {
      try {
        credentials = JSON.parse(savedCredentials)
      } catch {
        throw new Error(
          'Saved initial-admin.txt is invalid; restore the original file',
        )
      }
    } else {
      credentials = {
        username:
          environment.SUPERDSH_INITIAL_ADMIN_USERNAME?.trim() || 'admin',
        password: environment.SUPERDSH_INITIAL_ADMIN_PASSWORD || 'admin123',
        displayName:
          environment.SUPERDSH_INITIAL_ADMIN_DISPLAY_NAME?.trim() ||
          '星桥管理员',
      }
    }
    if (
      typeof credentials?.username !== 'string' ||
      !/^[a-z0-9_-]{3,32}$/.test(credentials.username) ||
      typeof credentials.password !== 'string' ||
      credentials.password.length < 8 ||
      credentials.password.length > 1024 ||
      typeof credentials.displayName !== 'string'
    )
      throw new Error(
        'Initial administrator requires a 3-32 character lowercase username and an 8-1024 character password',
      )
    if (savedCredentials === null)
      await writePrivateFile(
        credentialsPath,
        `${JSON.stringify(credentials, null, 2)}\n`,
      )
    await chmod(credentialsPath, 0o600)
    checkOwnership()
    await identity.createUser(credentials, { role: 'admin', bootstrap: true })
    log(
      'Initial Starbridge administrator created. Registration is closed by default.',
    )
    log(`Administrator username: ${credentials.username}`)
    log(`Administrator password: ${credentials.password}`)
    log(
      `Credentials saved to ${credentialsPath}; change the password after signing in.`,
    )
    return result
  } finally {
    await ownership.release()
  }
}

export async function main() {
  const environment = await deploymentEnvironment()
  const { createDatabase } =
    await import('../server/infrastructure/database.ts')
  const { serverConfiguration } =
    await import('../server/infrastructure/configuration.ts')
  const { ensureSchema } = await import('../server/infrastructure/schema.ts')
  const { IdentityService } = await import('../server/identity/service.ts')
  const database = createDatabase(environment.AGENT_SERVER_DB_URL)
  let configured
  try {
    configured = await bootstrapDeployment({
      environment,
      database,
      async initializeIdentity(values) {
        const configuration = serverConfiguration(values)
        await ensureSchema(database)
        const identity = new IdentityService(database, {
          secret: configuration.secret,
        })
        await identity.seedBuiltinRoles()
        return identity
      },
    })
  } finally {
    await database.close()
  }
  // Keep the existing platform entrypoint responsible for Host shutdown and leases.
  const child = fork(
    fileURLToPath(new URL('../server/main.ts', import.meta.url)),
    [],
    {
      env: configured,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    },
  )
  let stopping = false
  let ready = false
  child.on('message', (message) => {
    if (message?.type === 'superdsh:ready') ready = true
  })
  const stop = () => {
    if (stopping) return
    stopping = true
    if (ready && child.connected) child.send({ type: 'superdsh:shutdown' })
    else child.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (stopping ? 0 : signal ? 1 : 0)
      done()
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Deployment startup failed',
    )
    process.exitCode = 1
  })
