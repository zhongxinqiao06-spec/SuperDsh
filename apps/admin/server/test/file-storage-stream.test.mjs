import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import {
  createObjectStorage,
  parseRange,
  safeObjectKey,
} from '../files/object-storage.ts'
import { detectMediaType } from '../files/file-library.ts'

test('storage streams exact ranges and failed writes do not replace the original', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'superdsh-file-stream-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const store = createObjectStorage({ backend: 'local', root })
  await store.write('objects/one', Readable.from(['abcdef']), 6, 'text/plain')
  const chunks = []
  for await (const chunk of await store.read(
    'objects/one',
    parseRange('bytes=2-4', 6),
  ))
    chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), 'cde')
  await assert.rejects(
    store.write('objects/one', Readable.from(['bad']), 100, 'text/plain'),
    /size/,
  )
  assert.equal((await store.head('objects/one')).size, 6)
  await store.remove('objects/one')
  await assert.rejects(store.head('objects/one'))
})

test('ranges reject malformed and out-of-bounds input', () => {
  assert.deepEqual(parseRange('bytes=-3', 6), { start: 3, end: 5 })
  assert.deepEqual(parseRange('bytes=2-', 6), { start: 2, end: 5 })
  assert.deepEqual(parseRange('bytes=0-100', 6), { start: 0, end: 5 })
  for (const range of [
    'bytes=6-',
    'bytes=-0',
    'bytes=0-1,3-4',
    'bytes=4-2',
    'bytes=-',
    'items=0-3',
  ])
    assert.throws(() => parseRange(range, 6), /satisfiable/)
  assert.throws(() => parseRange('bytes=0-', 0), /satisfiable/)
})

test('storage rejects filesystem traversal and forged image types', () => {
  for (const key of [
    '../private',
    '/etc/a',
    'a//b',
    'a/../../x',
    'a\\b',
    'C:/x',
  ])
    assert.throws(() => safeObjectKey(key))
  assert.equal(safeObjectKey('objects/file_123'), 'objects/file_123')
  assert.throws(
    () => detectMediaType(Buffer.from('not an image'), 'a.png', 'image/png'),
    /实际格式/,
  )
  assert.throws(
    () => detectMediaType(Buffer.from('%PDF-data'), 'a.png', 'image/png'),
    /不一致/,
  )
  assert.equal(
    detectMediaType(Buffer.from('plain'), 'readme.md', ''),
    'text/plain',
  )
})
