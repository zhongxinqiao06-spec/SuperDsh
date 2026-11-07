import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { withTestDatabase } from './support/database.mjs'
import { IdentityService } from '../identity/service.ts'
import { StorageRegistry } from '../files/storage-registry.ts'
import { FileLibrary, uploadPartSize } from '../files/file-library.ts'
import { collectFileGarbage } from '../files/maintenance.ts'
import JSZip from 'jszip'

async function setup(t) {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, {
    secret: 'file-library-isolated-test',
  })
  await identity.seedBuiltinRoles()
  const user = await identity.createUser(
    {
      username: 'filesone',
      displayName: 'Files One',
      password: 'temporary-files-password',
    },
    { role: 'member' },
  )
  const other = await identity.createUser(
    {
      username: 'filestwo',
      displayName: 'Files Two',
      password: 'temporary-files-password',
    },
    { role: 'admin' },
  )
  const root = await mkdtemp(join(tmpdir(), 'superdsh-files-db-'))
  const registry = new StorageRegistry({
    db,
    root: join(root, 'objects'),
    encryptionKey: randomBytes(32).toString('base64url'),
    environment: {},
  })
  const library = new FileLibrary({
    db,
    registry,
    stagingDirectory: join(root, 'uploads'),
  })
  t.after(async () => {
    registry.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  return { db, library, registry, owner: user.userId, other: other.userId }
}
const sha = (data) => createHash('sha256').update(data).digest('hex')
const signal = () => new AbortController().signal

test('garbage collection is opt-in and preserves referenced files', async (t) => {
  const { db, library, registry, owner } = await setup(t)
  const old = new Date(Date.now() - 90 * 86400_000)
  const removable = await library.ingest(
    owner,
    '回收.txt',
    Buffer.from('remove'),
    'text/plain',
  )
  const kept = await library.ingest(
    owner,
    '引用.txt',
    Buffer.from('keep'),
    'text/plain',
    { kind: 'artifact', resourceId: 'retained-artifact' },
  )
  await library.trash(owner, removable.id)
  await db.query(
    'UPDATE file_entries SET deleted_at=$1 WHERE id=ANY($2::text[])',
    [old.toISOString(), [removable.id, kept.id]],
  )
  const store = await registry.get(registry.environmentId)
  for (const file of [removable, kept]) {
    const row = await library.row(owner, file.id, true)
    await utimes(join(registry.options.root, row.object_key), old, old)
  }
  await store.write(
    'objects/orphan',
    Readable.from(['orphan']),
    6,
    'text/plain',
  )
  await utimes(join(registry.options.root, 'objects/orphan'), old, old)
  const checked = await collectFileGarbage(library, false, signal())
  assert.equal(checked.recycledFiles, 1)
  assert.equal(checked.orphanObjects, 1)
  assert.equal((await store.head('objects/orphan')).size, 6)
  await collectFileGarbage(library, true, signal())
  await assert.rejects(library.entry(owner, removable.id, true), /无权/)
  await assert.rejects(store.head('objects/orphan'))
  assert.equal((await library.entry(owner, kept.id, true)).sha256, sha('keep'))
})

test('generated revisions retain the original bytes, reject rewiring and stay private before artifact publication', async (t) => {
  const { db, library, owner, other } = await setup(t)
  const original = await library.ingest(
    owner,
    '原稿.txt',
    Buffer.from('first'),
    'text/plain',
  )
  const revisionId = await library.saveLegacy(
    owner,
    'session',
    'synthetic-session',
    'artifact_second',
    '修订.txt',
    Buffer.from('second'),
    'text/plain',
  )
  await library.linkRevision(owner, revisionId, original.id)
  await library.linkRevision(owner, revisionId, original.id)
  const [revision] = await db.query(
    'SELECT version,previous_file_id FROM file_entries WHERE id=$1',
    [revisionId],
  )
  assert.equal(revision.version, 2)
  assert.equal(revision.previous_file_id, original.id)
  assert.equal(
    (await library.readBuffer(owner, original.id)).content.toString(),
    'first',
  )
  await assert.rejects(
    library.linkRevision(other, revisionId, original.id),
    /无权/,
  )
  await assert.rejects(
    library.linkRevision(owner, original.id, revisionId),
    /不可更改/,
  )
  await assert.rejects(library.entry(owner, revisionId), /无权/)
  const visible = []
  for (
    let entry = await library.nextMigrationEntry('');
    entry;
    entry = await library.nextMigrationEntry(entry.id)
  )
    visible.push(entry.id)
  assert.deepEqual(
    visible,
    [original.id],
    'uncommitted artifacts cannot be migrated or listed as final results',
  )
})

test('storage migration retries after interruption and retains the original bytes and stable file ID', async (t) => {
  const { db, library, registry, owner } = await setup(t)
  const bytes = Buffer.from('保留源文件并校验迁移')
  const file = await library.ingest(owner, '来源.txt', bytes, 'text/plain')
  const original = await library.row(owner, file.id)
  await db.query(
    "INSERT INTO file_storage_connections(id,name,backend,configuration_json,created_at,updated_at) VALUES('target','Target','local',$1,$2,$2)",
    [
      JSON.stringify({
        backend: 'local',
        root: join(registry.options.root, 'migration-target'),
      }),
      new Date().toISOString(),
    ],
  )
  const target = await registry.get('target', true),
    write = target.write.bind(target)
  target.write = async () => {
    throw Error('synthetic storage outage')
  }
  await assert.rejects(
    library.migrate(owner, file.id, 'target', signal()),
    /outage/,
  )
  assert.deepEqual((await library.readBuffer(owner, file.id)).content, bytes)
  assert.equal(
    (await library.row(owner, file.id)).storage_id,
    original.storage_id,
  )
  target.write = write
  assert.equal(
    (await library.migrate(owner, file.id, 'target', signal())).id,
    file.id,
  )
  assert.deepEqual((await library.readBuffer(owner, file.id)).content, bytes)
  assert.equal(
    (await library.migrate(owner, file.id, 'target', signal())).id,
    file.id,
  )
  const source = await registry.get(original.storage_id)
  assert.equal((await source.head(original.object_key)).size, bytes.length)
  assert.equal(
    (
      await db.query(
        'SELECT state FROM file_migration_items WHERE file_id=$1',
        [file.id],
      )
    )[0].state,
    'completed',
  )
})

test('Office uploads inspect their archive content instead of trusting a renamed extension', async (t) => {
  const { library, owner } = await setup(t)
  const zip = new JSZip()
  zip.file('unrelated.txt', 'not an Office document')
  const bad = await zip.generateAsync({ type: 'nodebuffer' })
  const upload = await library.begin(owner, {
    name: '伪造.pptx',
    size: bad.length,
    sha256: sha(bad),
    idempotencyKey: 'renamed-zip',
  })
  await library.part(owner, upload.id, 1, Readable.from([bad]), signal())
  await assert.rejects(
    library.complete(owner, upload.id, signal()),
    /Office 文件类型/,
  )
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml', '<presentation/>')
  const valid = await zip.generateAsync({ type: 'nodebuffer' })
  const next = await library.begin(owner, {
    name: '结构.pptx',
    size: valid.length,
    sha256: sha(valid),
    idempotencyKey: 'office-zip',
  })
  await library.part(owner, next.id, 1, Readable.from([valid]), signal())
  assert.match(
    (await library.complete(owner, next.id, signal())).mediaType,
    /presentationml/,
  )
})

test('uploads resume, complete idempotently, preserve revisions and enforce ownership', async (t) => {
  const { library, owner, other } = await setup(t)
  const content = Buffer.alloc(uploadPartSize + 15, 65)
  const body = {
    name: '公司资料.txt',
    size: content.length,
    sha256: sha(content),
    mediaType: 'text/plain',
    idempotencyKey: 'first',
  }
  const upload = await library.begin(owner, body)
  assert.equal((await library.begin(owner, body)).id, upload.id)
  await assert.rejects(
    library.begin(owner, { ...body, name: 'different.txt' }),
    /不同文件/,
  )
  await assert.rejects(library.uploadStatus(other, upload.id), /不存在/)
  await library.part(
    owner,
    upload.id,
    1,
    Readable.from([content.subarray(0, uploadPartSize)]),
    signal(),
  )
  assert.deepEqual(
    (await library.uploadStatus(owner, upload.id)).receivedParts,
    [1],
  )
  await assert.rejects(library.complete(owner, upload.id, signal()), /完整/)
  await library.part(
    owner,
    upload.id,
    2,
    Readable.from([content.subarray(uploadPartSize)]),
    signal(),
  )
  const file = await library.complete(owner, upload.id, signal())
  assert.equal((await library.complete(owner, upload.id, signal())).id, file.id)
  assert.equal(
    (await library.readBuffer(owner, file.id)).content.length,
    content.length,
  )
  await assert.rejects(library.entry(other, file.id), /无权/)
  assert.equal((await library.list(other, new URLSearchParams())).total, 0)
  await library.trash(owner, file.id)
  await assert.rejects(library.readBuffer(owner, file.id), /无权/)
  await library.trash(owner, file.id, true)
  const changed = Buffer.from('revised')
  const revision = await library.begin(owner, {
    ...body,
    size: changed.length,
    sha256: sha(changed),
    previousFileId: file.id,
    idempotencyKey: 'revision',
  })
  await library.part(owner, revision.id, 1, Readable.from([changed]), signal())
  const next = await library.complete(owner, revision.id, signal())
  assert.equal(next.version, 2)
  assert.equal(next.previousFileId, file.id)
  assert.equal((await library.entry(owner, file.id)).sha256, sha(content))
})

test('bad hashes and cancellation never publish content; referenced files cannot be removed', async (t) => {
  const { library, owner } = await setup(t)
  const upload = await library.begin(owner, {
    name: 'wrong.txt',
    size: 3,
    sha256: sha('xyz'),
    idempotencyKey: 'wrong',
  })
  await library.part(owner, upload.id, 1, Readable.from(['abc']), signal())
  await assert.rejects(library.complete(owner, upload.id, signal()), /校验失败/)
  assert.equal((await library.list(owner, new URLSearchParams())).total, 0)
  await library.cancel(owner, upload.id)
  await assert.rejects(library.complete(owner, upload.id, signal()), /关闭/)
  const bound = await library.ingest(
    owner,
    '资料.txt',
    Buffer.from('known'),
    'text/plain',
    { kind: 'knowledge', resourceId: 'synthetic-source' },
  )
  await assert.rejects(library.trash(owner, bound.id), /引用/)
})
