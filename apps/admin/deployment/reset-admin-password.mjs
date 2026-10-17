import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { deploymentEnvironment } from './bootstrap.mjs'
import { createDatabase } from '../server/infrastructure/database.ts'
import { IdentityService } from '../server/identity/service.ts'

const usage =
  'Usage: node apps/admin/deployment/reset-admin-password.mjs --username admin --password-stdin'

export class ResetPasswordError extends Error {}

function validUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-z0-9_-]{3,32}$/.test(username))
    throw new ResetPasswordError(
      'An existing administrator username is required.',
    )
  return username
}

function validPassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 1024 ||
    /[\r\n\u0000]/.test(password)
  )
    throw new ResetPasswordError(
      'Password input must be one line of 8-1024 characters.',
    )
  return password
}

export function parseResetArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  let username
  let passwordStdin = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--username' && username === undefined) {
      username = args[++index]
    } else if (args[index] === '--password-stdin' && !passwordStdin) {
      passwordStdin = true
    } else throw new ResetPasswordError(usage)
  }
  if (!passwordStdin) throw new ResetPasswordError(usage)
  return { username: validUsername(username), help: false }
}

export async function readPasswordInput(input) {
  if (input.isTTY)
    throw new ResetPasswordError(
      'Pipe the password to standard input; interactive input is not accepted.',
    )
  const chunks = []
  let length = 0
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk)
      chunks.push(bytes)
      length += bytes.length
      if (length > 4098)
        throw new ResetPasswordError('Password input is too long.')
    }
    const bytes = Buffer.concat(chunks)
    try {
      return validPassword(
        new TextDecoder('utf-8', { fatal: true })
          .decode(bytes)
          .replace(/\r?\n$/, ''),
      )
    } finally {
      bytes.fill(0)
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

/** Takes ownership of the database handle and always closes it. */
export async function resetAdminPassword({
  database,
  identity,
  username,
  password,
}) {
  let ownership
  let lost = false
  const checkOwnership = () => {
    if (lost)
      throw new ResetPasswordError(
        'Database ownership was lost; the password reset was cancelled.',
      )
  }
  try {
    username = validUsername(username)
    validPassword(password)
    ownership = await database.lease('superdsh:platform-api')
    if (!ownership)
      throw new ResetPasswordError(
        'Stop the platform service before resetting its administrator password.',
      )
    void ownership.lost.then(
      () => {
        lost = true
      },
      () => {
        lost = true
      },
    )
    checkOwnership()
    const stored = await identity.passwordHash({ password })
    checkOwnership()
    await database.transaction(async (connection) => {
      // Match management mutations: the shared identity lock precedes user locks.
      await connection.query('SELECT pg_advisory_xact_lock(4141455)')
      checkOwnership()
      const [row] = await connection.query(
        'SELECT id FROM users WHERE username=$1 FOR UPDATE',
        [username],
      )
      if (!row)
        throw new ResetPasswordError(
          'The administrator account does not exist; no account was created.',
        )
      const user = await identity.getUser(row.id, connection)
      if (user.deletedAt || user.disabled || !user.roles.includes('admin'))
        throw new ResetPasswordError(
          'The account must be an enabled, undeleted administrator.',
        )
      checkOwnership()
      await identity.changePassword(user.userId, stored, connection)
      checkOwnership()
      await identity.audit(
        'deployment-cli',
        'user.password_reset',
        user.userId,
        { source: 'deployment-cli' },
        connection,
      )
      checkOwnership()
    })
  } finally {
    try {
      await ownership?.release()
    } finally {
      await database.close()
    }
  }
}

export async function runResetCommand({
  args = process.argv.slice(2),
  input = process.stdin,
  environment = process.env,
  databaseFactory = createDatabase,
  log = console.log,
  error = console.error,
} = {}) {
  try {
    const parsed = parseResetArguments(args)
    if (parsed.help) {
      log(usage)
      return 0
    }
    const password = await readPasswordInput(input)
    const configured = await deploymentEnvironment(environment)
    const database = databaseFactory(configured.AGENT_SERVER_DB_URL)
    // Password hashing needs no deployment signing or model encryption key.
    // This one-shot service never signs tokens or starts application processes.
    const identity = new IdentityService(database, {
      secret: randomBytes(32).toString('base64url'),
    })
    await resetAdminPassword({
      database,
      identity,
      username: parsed.username,
      password,
    })
    log(
      'Administrator password reset. Existing sessions and recovery codes were revoked. Start the platform service to sign in.',
    )
    return 0
  } catch (cause) {
    error(
      cause instanceof ResetPasswordError
        ? cause.message
        : 'Administrator password reset failed. Check database availability and try again; no credentials were printed.',
    )
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runResetCommand()
