import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withTestDatabase } from './support/database.mjs'
import { importExistingAgentData } from '../runtime/import-agent-command.ts'
import {
  importArguments,
  importEnvironment,
} from '../../../../scripts/import-agent-data.mjs'

async function fixture(t) {
  const database = await withTestDatabase(t)
  const root = await mkdtemp(join(tmpdir(), 'superdsh-import-cli-中文-'))
  const sourceDirectory = join(root, 'export')
  const dataDirectory = join(root, 'native')
  for (const name of ['home', 'workspace'])
    await mkdir(join(sourceDirectory, name), { recursive: true })
  await writeFile(
    join(sourceDirectory, 'home/history.json'),
    '{"synthetic":"history"}',
  )
  await writeFile(
    join(sourceDirectory, 'workspace/code.txt'),
    'synthetic workspace',
  )
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('superdsh-import-cli-中文-'))
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date().toISOString()
  await database.query(
    "INSERT INTO users(id,username,password_hash,role,display_name,created_at,updated_at) VALUES('alice','alice','synthetic-unused','member','Alice',$1,$1)",
    [now],
  )
  await database.query(
    "INSERT INTO connectors(id,user_id,name,executor_kind,status,token_hash,token_prefix,created_at,updated_at) VALUES('conn_old_alice','alice','Original','server-agent','offline','synthetic-hash','synthetic-prefix',$1,$1)",
    [now],
  )
  await database.query(
    "INSERT INTO server_agents(owner_user_id,connector_id,runtime_id,credential_ciphertext,created_at,updated_at) VALUES('alice','conn_old_alice','dsh','synthetic-preserve',$1,$1)",
    [now],
  )
  return {
    root,
    database,
    sourceDirectory,
    dataDirectory,
    ownerUserId: 'alice',
    connectorId: 'conn_old_alice',
  }
}

test('offline CLI validates existing ownership, imports through saved env and leaves database/source unchanged', async (t) => {
  const f = await fixture(t)
  const before = await f.database.query('SELECT * FROM server_agents')
  const secret = randomBytes(32).toString('hex')
  const envFile = join(f.root, 'synthetic.env')
  await writeFile(
    envFile,
    [
      `AGENT_SERVER_DB_URL=${f.database.testUrl}`,
      'AGENT_SERVER_REDIS_URL=redis://127.0.0.1:1/0',
      `AGENT_SERVER_SECRET=${secret}`,
      `SUPERDSH_MODEL_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
      `SUPERDSH_SERVER_DATA_DIR=${JSON.stringify(f.dataDirectory.replaceAll('\\', '/'))}`,
    ].join('\n'),
  )
  const script = fileURLToPath(
    new URL('../../../../scripts/import-agent-data.mjs', import.meta.url),
  )
  const result = await promisify(execFile)(
    process.execPath,
    [
      script,
      '--env',
      envFile,
      '--source',
      f.sourceDirectory,
      '--user-id',
      f.ownerUserId,
      '--connector-id',
      f.connectorId,
    ],
    {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      timeout: 15000,
      windowsHide: true,
    },
  )
  assert.match(result.stdout, /Imported 2 files/)
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret))
  const target = join(
    f.dataDirectory,
    'agents',
    createHash('sha256').update('alice').digest('hex'),
  )
  assert.equal(
    JSON.parse(await readFile(join(target, 'native-runtime.json'), 'utf8'))
      .connectorId,
    f.connectorId,
  )
  assert.equal(
    await readFile(join(target, 'home/history.json'), 'utf8'),
    await readFile(join(f.sourceDirectory, 'home/history.json'), 'utf8'),
  )
  assert.deepEqual(
    await f.database.query('SELECT * FROM server_agents'),
    before,
  )
  await assert.rejects(importExistingAgentData(f), /empty/)
  const released = await f.database.lease('superdsh:platform-api')
  assert.ok(released)
  await released.release()
})

test('wrong owner or Connector and a running API/Agent reject before creating a target', async (t) => {
  const f = await fixture(t)
  for (const overrides of [
    { ownerUserId: 'bob' },
    { connectorId: 'conn_other' },
  ])
    await assert.rejects(
      importExistingAgentData({ ...f, ...overrides }),
      /existing server Agent binding/,
    )
  for (const name of ['superdsh:platform-api', 'server-agent:alice']) {
    const lease = await f.database.lease(name)
    try {
      await assert.rejects(importExistingAgentData(f), /running|active Agent/)
    } finally {
      await lease.release()
    }
  }
  await assert.rejects(readdir(f.dataDirectory), { code: 'ENOENT' })
})

test('database ownership loss cancels import and releases its locks', async (t) => {
  const f = await fixture(t)
  const database = {
    ...f.database,
    lease: async (key) => {
      const lease = await f.database.lease(key)
      return {
        ...lease,
        lost: Promise.resolve(new Error('synthetic ownership loss')),
      }
    },
  }
  await assert.rejects(
    importExistingAgentData({ ...f, database }),
    /ownership was lost/,
  )
  await assert.rejects(readdir(f.dataDirectory), { code: 'ENOENT' })
  const released = await f.database.lease('superdsh:platform-api')
  assert.ok(released)
  await released.release()
})

test('CLI refuses missing options, relative source, unknown flags and missing saved env without generating credentials', () => {
  for (const args of [
    [],
    ['--unknown', 'value'],
    [
      '--source',
      'relative',
      '--user-id',
      'alice',
      '--connector-id',
      'conn_old',
    ],
  ])
    assert.throws(() => importArguments(args), /Usage/)
  assert.throws(
    () =>
      importEnvironment(
        join(tmpdir(), `absent-import-${randomBytes(8).toString('hex')}.env`),
        {},
      ),
    /No new keys/,
  )
})
