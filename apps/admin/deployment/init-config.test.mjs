import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeDatabasePassword } from './init-config.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'starbridge-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    databaseDirectory: directory,
    owner: process.getuid?.(),
    password: '',
  }
}

test('fresh deployment generates one persistent random database password', (t) => {
  const options = fixture(t)
  const file = initializeDatabasePassword(options)
  const password = readFileSync(file, 'utf8')
  assert.match(password, /^[0-9a-f]{64}$/u)
  initializeDatabasePassword(options)
  assert.equal(readFileSync(file, 'utf8'), password)
})

test('explicit initial password is preserved and changes cannot reset a database', (t) => {
  const options = { ...fixture(t), password: 'initial-database-password' }
  const file = initializeDatabasePassword(options)
  assert.equal(readFileSync(file, 'utf8'), options.password)
  initializeDatabasePassword(options)
  assert.throws(
    () => initializeDatabasePassword({ ...options, password: 'replacement' }),
    /does not match/u,
  )
  assert.equal(readFileSync(file, 'utf8'), options.password)
})

test('existing PostgreSQL volume without saved credentials fails closed', (t) => {
  const options = fixture(t)
  writeFileSync(join(options.databaseDirectory, 'PG_VERSION'), '17')
  assert.throws(
    () => initializeDatabasePassword(options),
    /Existing PostgreSQL/u,
  )
})

test('corrupt saved password is not silently replaced', (t) => {
  const options = fixture(t)
  writeFileSync(join(options.directory, 'postgres-password'), '')
  assert.throws(
    () => initializeDatabasePassword(options),
    /saved database password/u,
  )
})

test('database password overrides cannot introduce ambiguous whitespace', (t) => {
  const options = fixture(t)
  for (const password of [' secret', 'secret ', 'secret\npassword'])
    assert.throws(
      () => initializeDatabasePassword({ ...options, password }),
      /single line without surrounding whitespace/u,
    )
})
