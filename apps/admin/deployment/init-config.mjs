import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function initializeDatabasePassword({
  directory = '/data/config',
  databaseDirectory = '/var/lib/postgresql/data',
  password = process.env.POSTGRES_PASSWORD || '',
  owner = process.platform === 'win32' ? undefined : 1000,
} = {}) {
  const file = join(directory, 'postgres-password')
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim()
    if (!saved || (password && password !== saved))
      throw new Error(
        'POSTGRES_PASSWORD does not match the saved database password; restore the original configuration.',
      )
    return file
  }
  if (existsSync(join(databaseDirectory, 'PG_VERSION')))
    throw new Error(
      'Existing PostgreSQL data has no saved password. Restore its config-data backup before starting.',
    )
  if (password && (/[\r\n\0]/u.test(password) || password !== password.trim()))
    throw new Error(
      'POSTGRES_PASSWORD must be a single line without surrounding whitespace',
    )
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  if (owner !== undefined) chownSync(directory, owner, owner)
  chmodSync(directory, 0o755)
  // PostgreSQL reads this file after dropping to its own UID. Other application
  // secrets use mode 0600; only the internal database password is shared here.
  writeFileSync(file, password || randomBytes(32).toString('hex'), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  })
  return file
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const existingDatabase = existsSync('/var/lib/postgresql/data/PG_VERSION')
    initializeDatabasePassword()
    initializeStorageConfiguration({ existingDatabase })
    console.log('Persistent database configuration is ready.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

export function initializeStorageConfiguration({
  directory = '/data/config',
  storageDirectory = '/minio-data',
  existingDatabase = false,
  owner = process.platform === 'win32' ? undefined : 1000,
  storageOwner = process.platform === 'win32' ? undefined : 10001,
} = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  const entries = [
    [
      'minio-root-user',
      'superdsh-' + randomBytes(8).toString('hex'),
      storageOwner,
    ],
    ['minio-root-password', randomBytes(32).toString('hex'), storageOwner],
    ['minio-app-user', 'application-' + randomBytes(8).toString('hex'), owner],
    ['minio-app-password', randomBytes(32).toString('hex'), owner],
  ]
  const existing = existsSync(join(storageDirectory, '.minio.sys'))
  if (!existing) {
    mkdirSync(storageDirectory, { recursive: true, mode: 0o700 })
    if (storageOwner !== undefined) chownSync(storageDirectory, storageOwner, storageOwner)
  }
  for (const [name, value, uid] of entries) {
    const path = join(directory, name)
    if (existsSync(path)) {
      if (!readFileSync(path, 'utf8').trim())
        throw new Error('Empty storage credential file: ' + name)
      continue
    }
    if (existing)
      throw new Error(
        'Existing MinIO data has incomplete credentials; restore the config-data backup.',
      )
    writeFileSync(path, value, { flag: 'wx', mode: 0o600 })
    if (uid !== undefined) chownSync(path, uid, uid)
  }
  const selection = join(directory, 'storage-backend')
  if (!existsSync(selection)) {
    writeFileSync(selection, existingDatabase ? 'local' : 's3', {
      flag: 'wx',
      mode: 0o644,
    })
    if (owner !== undefined) chownSync(selection, owner, owner)
  }
}
