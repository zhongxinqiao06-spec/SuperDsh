import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { once } from 'node:events'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { importAgentData } from '../runtime/import-agent-data.ts'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-import-中文-'))
  const sourceDirectory = join(directory, 'export')
  const rootDirectory = join(directory, 'native')
  for (const child of ['home/sessions', 'workspace', 'connector'])
    await mkdir(join(sourceDirectory, child), { recursive: true })
  await writeFile(
    join(sourceDirectory, 'home/sessions/history.jsonl'),
    '{"synthetic":"history"}\n',
  )
  await writeFile(
    join(sourceDirectory, 'workspace/project.txt'),
    'synthetic project',
  )
  await writeFile(
    join(sourceDirectory, 'connector/sync-state.json'),
    '{"synthetic":"checkpoint"}',
  )
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.includes('superdsh-import-中文-'))
    await rm(directory, { recursive: true, force: true })
  })
  return {
    sourceDirectory,
    rootDirectory,
    ownerUserId: 'alice',
    connectorId: 'conn_old_alice',
  }
}

test('offline exported volume imports atomically, preserves source and omits runtime installation/lease artifacts', async (t) => {
  const options = await fixture(t)
  await mkdir(
    join(options.sourceDirectory, 'home/profiles/server/node_modules'),
    { recursive: true },
  )
  await writeFile(
    join(
      options.sourceDirectory,
      'home/profiles/server/node_modules/old-install',
    ),
    'old-linux-install',
  )
  await writeFile(
    join(options.sourceDirectory, 'connector/runtime.json'),
    '{"pid":42}',
  )
  const before = await readFile(
    join(options.sourceDirectory, 'home/sessions/history.jsonl'),
  )
  const result = await importAgentData(options)
  assert.equal(
    result.directory,
    join(
      options.rootDirectory,
      createHash('sha256').update('alice').digest('hex'),
    ),
  )
  assert.equal(result.copiedFiles, 3)
  assert.deepEqual(
    new Set(result.skipped),
    new Set(['connector/runtime.json', 'home/profiles/server/node_modules']),
  )
  assert.deepEqual(
    await readFile(join(result.directory, 'home/sessions/history.jsonl')),
    before,
  )
  assert.deepEqual(
    await readFile(
      join(options.sourceDirectory, 'home/sessions/history.jsonl'),
    ),
    before,
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(result.directory, 'native-runtime.json'), 'utf8'),
    ),
    {
      version: 1,
      storage: 'native',
      ownerUserId: 'alice',
      connectorId: 'conn_old_alice',
    },
  )
  await assert.rejects(importAgentData(options), /empty/)
  assert.equal(
    await readFile(join(result.directory, 'workspace/project.txt'), 'utf8'),
    'synthetic project',
  )
  assert.deepEqual(await readdir(options.rootDirectory), [
    createHash('sha256').update('alice').digest('hex'),
  ])
})

test('source locks and live Bridge endpoints prevent import', async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.sourceDirectory, '.lock'), 'owned source lock')
  await assert.rejects(importAgentData(options), /lock/)
  await rm(join(options.sourceDirectory, '.lock'))
  const bridge = createServer((socket) => socket.end())
  bridge.listen(0, '127.0.0.1')
  await once(bridge, 'listening')
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  await mkdir(join(options.sourceDirectory, 'home/agents-anywhere/bridge'), {
    recursive: true,
  })
  await writeFile(
    join(options.sourceDirectory, 'home/agents-anywhere/bridge/endpoint.json'),
    JSON.stringify({ host: '127.0.0.1', port: bridge.address().port }),
  )
  await assert.rejects(importAgentData(options), /active/)
  assert.deepEqual(await readdir(options.rootDirectory), [])
})

test('links abort a staged import and roll back without modifying the source or empty target', async (t) => {
  const options = await fixture(t)
  const digest = createHash('sha256').update('alice').digest('hex')
  await mkdir(join(options.rootDirectory, digest), { recursive: true })
  await symlink(
    join(options.sourceDirectory, 'home'),
    join(options.sourceDirectory, 'workspace/link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(importAgentData(options), /symbolic link/)
  assert.deepEqual(await readdir(options.rootDirectory), [digest])
  assert.deepEqual(await readdir(join(options.rootDirectory, digest)), [])
  assert.equal(
    await readFile(
      join(options.sourceDirectory, 'workspace/project.txt'),
      'utf8',
    ),
    'synthetic project',
  )
})

test('overlap, invalid identities and linked targets are rejected', async (t) => {
  const options = await fixture(t)
  await assert.rejects(
    importAgentData({
      ...options,
      rootDirectory: join(options.sourceDirectory, 'nested'),
    }),
    /overlap/,
  )
  await assert.rejects(
    importAgentData({ ...options, connectorId: '../outside' }),
    /Connector/,
  )
  await assert.rejects(
    importAgentData({ ...options, ownerUserId: ' ' }),
    /user ID/,
  )
  await mkdir(options.rootDirectory)
  await symlink(
    join(options.sourceDirectory, 'home'),
    join(
      options.rootDirectory,
      createHash('sha256').update('alice').digest('hex'),
    ),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(importAgentData(options), /links/)
})

for (const compression of ['none', 'zstd']) {
  test(`container workspace relocation preserves ${compression} conversation events and resumes with the real Harness persistence`, async (t) => {
    const options = await fixture(t)
    const id = 'preserved-native-session'
    const directory = join(
      options.sourceDirectory,
      'home/sessions/--workspace--',
      id,
    )
    await mkdir(directory, { recursive: true })
    const header = {
      type: 'session',
      version: 4,
      id,
      createdAt: 1000,
      cwd: '/workspace',
      isSeeded: false,
      delegationDepth: 0,
    }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'turn/end',
        seq: 1,
        time: 2,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ]
    const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`)
    const eventBytes = Buffer.from(
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    )
    const compress = (bytes) =>
      zstdCompressSync(bytes, {
        params: { [constants.ZSTD_c_checksumFlag]: 1 },
      })
    const eventFrames =
      compression === 'zstd' ? compress(eventBytes) : eventBytes
    const before = Buffer.concat([
      compression === 'zstd' ? compress(headerBytes) : headerBytes,
      eventFrames,
    ])
    const filename = `session.v4.jsonl${compression === 'zstd' ? '.zstd' : ''}`
    const original = join(directory, filename)
    await writeFile(original, before)
    await writeFile(join(directory, 'session.lock'), '')
    const storages = join(options.sourceDirectory, 'home/storages')
    await mkdir(join(storages, 'session_projcache/sessions'), {
      recursive: true,
    })
    await writeFile(
      join(storages, 'session_projcache/sessions', `${id}.json`),
      '{"synthetic":"stale fold"}',
    )
    const registry = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: ['ws-existing'],
        archivedSessionIds: [],
        pinnedSessionIds: [id],
      },
      tables: {
        workspaces: {
          'ws-existing': {
            path: '/workspace',
            title: '保留名称',
            sessionIds: [id],
            createdAt: 'old',
            updatedAt: 'old',
          },
        },
      },
    }
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(registry))
    await mkdir(
      join(
        options.sourceDirectory,
        'home/agents-anywhere/bridge/create-intents',
      ),
      { recursive: true },
    )
    await writeFile(
      join(
        options.sourceDirectory,
        'home/agents-anywhere/bridge/create-intents/receipt.json',
      ),
      '{"synthetic":"keep deduplication receipt"}',
    )
    const result = await importAgentData(options)
    assert.equal(result.relocatedSessions, 1)
    assert.deepEqual(await readFile(original), before)
    const roots = await readdir(join(result.directory, 'home/sessions'), {
      withFileTypes: true,
    })
    const current = roots.find(
      (entry) => entry.isDirectory() && entry.name !== '--workspace--',
    )
    assert.ok(current)
    const migrated = join(
      result.directory,
      'home/sessions',
      current.name,
      id,
      filename,
    )
    const bytes = await readFile(migrated)
    assert.deepEqual(
      bytes.subarray(bytes.length - eventFrames.length),
      eventFrames,
    )
    const plaintext = compression === 'zstd' ? zstdDecompressSync(bytes) : bytes
    assert.deepEqual(JSON.parse(plaintext.toString().split('\n')[0]), {
      ...header,
      cwd: join(result.directory, 'workspace'),
    })
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(result.directory, 'home/storages/workspace.json'),
          'utf8',
        ),
      ),
      {
        ...registry,
        tables: {
          workspaces: {
            'ws-existing': {
              ...registry.tables.workspaces['ws-existing'],
              path: join(result.directory, 'workspace'),
            },
          },
        },
      },
    )
    await assert.rejects(
      readdir(join(result.directory, 'home/storages/session_projcache')),
      { code: 'ENOENT' },
    )
    assert.equal(
      await readFile(
        join(
          result.directory,
          'home/agents-anywhere/bridge/create-intents/receipt.json',
        ),
        'utf8',
      ),
      '{"synthetic":"keep deduplication receipt"}',
    )

    // The pinned reader validates directory/header identity and actually appends
    // another turn; string replacement alone cannot satisfy this assertion.
    const require = createRequire(
      fileURLToPath(
        new URL(
          '../../../desktop/plugins/harness/package.json',
          import.meta.url,
        ),
      ),
    )
    const load = (name) => import(pathToFileURL(require.resolve(name)).href)
    const { Context } = await load('@deepseek-ai/cordis')
    const { default: Persistence } = await load(
      '@deepseek-ai/dsh-session-persistence-jsonl',
    )
    const context = new Context()
    const fiber = await context.plugin(Persistence, {
      root: join(result.directory, 'home/sessions'),
      compression,
    })
    try {
      const persisted = await context.sessionPersistence.open(id, {
        access: 'write',
      })
      try {
        assert.equal(persisted.header.cwd, join(result.directory, 'workspace'))
        assert.deepEqual((await persisted.read()).events, events)
        const next = [
          { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
          {
            type: 'turn/end',
            seq: 3,
            time: 4,
            data: { turn: 2, reason: { kind: 'completed' } },
          },
        ]
        await persisted.append(next)
        assert.deepEqual((await persisted.read()).events, [...events, ...next])
      } finally {
        await persisted.close()
      }
    } finally {
      await fiber.dispose()
    }
    assert.deepEqual(await readFile(original), before)
  })
}

test('invalid exported workspace metadata aborts relocation before committing and keeps source intact', async (t) => {
  const options = await fixture(t)
  const path = join(
    options.sourceDirectory,
    'home/sessions/--workspace--/bad/session.v4.jsonl.zstd',
  )
  await mkdir(dirname(path), { recursive: true })
  const broken = zstdCompressSync(
    Buffer.from(
      '{"type":"session","version":4,"id":"bad","cwd":"/workspace/../other"}\n',
    ),
  )
  await writeFile(path, broken)
  await assert.rejects(importAgentData(options), /escapes its original root/)
  assert.deepEqual(await readFile(path), broken)
  assert.deepEqual(await readdir(options.rootDirectory), [])
})

test('Windows path escapes and mismatched native session IDs fail the whole import', async (t) => {
  for (const patch of [
    { cwd: '/workspace/..\\..\\outside' },
    { cwd: '/workspace/C:/outside' },
    { cwd: '/workspace/unsafe\0name' },
    { id: '../different-session' },
  ]) {
    const options = await fixture(t)
    const path = join(
      options.sourceDirectory,
      'home/sessions/--workspace--/original/session.v4.jsonl',
    )
    await mkdir(dirname(path), { recursive: true })
    const header = `${JSON.stringify({ type: 'session', version: 4, id: 'original', cwd: '/workspace', ...patch })}\n`
    await writeFile(path, header)
    await assert.rejects(
      importAgentData(options),
      /unsupported path separator|does not match/,
    )
    assert.equal(await readFile(path, 'utf8'), header)
    assert.deepEqual(await readdir(options.rootDirectory), [])
  }
})

test('unsupported authoritative session generations cannot commit a native marker', async (t) => {
  for (const filename of [
    'session.v3.jsonl',
    'session.v3.jsonl.zstd',
    'session.v5.jsonl',
    'session.jsonl',
  ]) {
    const options = await fixture(t)
    const file = join(
      options.sourceDirectory,
      'home/sessions/--workspace--/legacy',
      filename,
    )
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'synthetic older session')
    await assert.rejects(importAgentData(options), /请先用原版本完成会话升级/)
    assert.equal(await readFile(file, 'utf8'), 'synthetic older session')
    assert.deepEqual(await readdir(options.rootDirectory), [])
  }
})
