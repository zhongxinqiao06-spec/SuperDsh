import { createHash } from 'node:crypto'
import { readdir, stat, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { ApiError, text, utcNow } from '../http/api-router.ts'
import type { FileLibrary } from './file-library.ts'

/** Explicit resumable maintenance. Original DB blobs and old storage objects are never removed. */
export async function importLegacyFileContents(
  library: FileLibrary,
  apply: boolean,
  signal: AbortSignal,
) {
  const db = library.options.db,
    counts = { knowledge: 0, attachments: 0, imported: 0, existing: 0 }
  let cursor = ''
  while (true) {
    signal.throwIfAborted()
    const [asset] = await db.query(
      'SELECT * FROM business_agent_assets WHERE id>$1 ORDER BY id LIMIT 1',
      [cursor],
    )
    if (!asset) break
    cursor = text(asset.id)
    counts.knowledge++
    const kind = asset.kind === 'knowledge' ? 'knowledge' : 'template'
    if (await library.legacy(kind, cursor, cursor)) {
      counts.existing++
      continue
    }
    if (
      !Buffer.isBuffer(asset.content) ||
      createHash('sha256').update(asset.content).digest('hex') !== asset.sha256
    )
      throw new ApiError(409, '知识原文校验失败：' + cursor)
    if (apply) {
      await library.saveLegacy(
        text(asset.owner_user_id),
        kind,
        cursor,
        cursor,
        text(asset.name),
        asset.content,
        text(asset.media_type),
      )
      counts.imported++
    }
  }
  const source = await library.options.registry.get(
    library.options.registry.environmentId,
  )
  for await (const item of source.list()) {
    signal.throwIfAborted()
    const match = /^([\w-]{1,200})\/([\w-]{1,200})\.json$/.exec(item.key)
    if (!match || item.size > 1024 * 1024) continue
    const session = match[1]!,
      file = match[2]!
    const [owner] = await db.query(
      'SELECT c.user_id FROM sessions s JOIN connectors c ON c.id=s.connector_id WHERE s.id=$1',
      [session],
    )
    if (!owner) throw new ApiError(409, '旧附件缺少所属会话：' + session)
    counts.attachments++
    if (await library.legacy('session', session, file)) {
      counts.existing++
      continue
    }
    const metadataParts: Buffer[] = []
    for await (const chunk of await source.read(item.key, undefined, signal))
      metadataParts.push(Buffer.from(chunk))
    const metadata = JSON.parse(Buffer.concat(metadataParts).toString('utf8'))
    const size = Number(metadata.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024)
      throw new ApiError(413, '旧附件超出兼容迁移上限：' + file)
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of await source.read(
      `${session}/${file}.bin`,
      undefined,
      signal,
    )) {
      const bytes = Buffer.from(chunk)
      received += bytes.length
      if (received > size) throw new ApiError(409, '旧附件大小不匹配：' + file)
      chunks.push(bytes)
    }
    const content = Buffer.concat(chunks)
    if (
      content.length !== size ||
      createHash('sha256').update(content).digest('hex') !== metadata.sha256
    )
      throw new ApiError(409, '旧附件校验失败：' + file)
    if (apply) {
      await library.saveLegacy(
        text(owner.user_id),
        'session',
        session,
        file,
        text(metadata.name),
        content,
        text(metadata.mediaType),
      )
      counts.imported++
    }
  }
  return counts
}

/** Run only while holding platform ownership. Foreign paths and referenced versions are never purged. */
export async function collectFileGarbage(
  library: FileLibrary,
  apply: boolean,
  signal: AbortSignal,
) {
  const db = library.options.db,
    settings = await library.options.registry.settings()
  const temporaryCutoff = new Date(
    Date.now() - settings.policy.temporaryHours * 3600_000,
  ).toISOString()
  const recycleCutoff = new Date(
    Date.now() - settings.policy.recycleDays * 86400_000,
  ).toISOString()
  const counts = {
    expiredUploads: 0,
    recycledFiles: 0,
    orphanObjects: 0,
    stagedParts: 0,
    obsoleteReferences: 0,
    incompleteUploads: 0,
  }
  const obsolete = `((kind='session' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=resource_id)) OR (kind IN ('knowledge','template') AND NOT EXISTS(SELECT 1 FROM business_agent_assets WHERE id=resource_id)))`
  counts.obsoleteReferences = Number(
    (
      await db.query(
        'SELECT COUNT(*) AS total FROM file_references WHERE ' + obsolete,
      )
    )[0]?.total || 0,
  )
  if (apply)
    await db.transaction(async (conn) => {
      await conn.query('DELETE FROM file_references WHERE ' + obsolete)
      await conn.query('DELETE FROM file_legacy_mappings WHERE ' + obsolete)
    })
  const uploads = await db.query(
    "SELECT id FROM file_uploads WHERE expires_at<$1 AND state<>'completed'",
    [utcNow()],
  )
  counts.expiredUploads = uploads.length
  if (apply)
    for (const row of uploads) {
      signal.throwIfAborted()
      await db.query("UPDATE file_uploads SET state='cancelled' WHERE id=$1", [
        row.id,
      ])
      await db.query('DELETE FROM file_upload_parts WHERE upload_id=$1', [
        row.id,
      ])
    }
  const staging = resolve(library.options.stagingDirectory)
  for (const item of await readdir(staging, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )) {
    if (!item.isFile()) continue
    const path = resolve(staging, item.name)
    if (!path.startsWith(staging + sep)) throw new Error('Invalid staging path')
    if ((await stat(path)).mtime.toISOString() >= temporaryCutoff) continue
    if (
      (
        await db.query(
          "SELECT p.path FROM file_upload_parts p JOIN file_uploads u ON u.id=p.upload_id WHERE p.path=$1 AND u.state IN ('receiving','completing') AND u.expires_at>$2",
          [path, utcNow()],
        )
      ).length
    )
      continue
    counts.stagedParts++
    if (apply) await unlink(path)
  }
  const recycled = await db.query(
    `SELECT e.id,e.object_id FROM file_entries e WHERE e.deleted_at<$1 AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=e.id) AND NOT EXISTS(SELECT 1 FROM file_entries v WHERE v.previous_file_id=e.id) AND NOT EXISTS(SELECT 1 FROM file_legacy_mappings l WHERE l.file_id=e.id) AND NOT EXISTS(SELECT 1 FROM file_migration_items m WHERE m.file_id=e.id)`,
    [recycleCutoff],
  )
  counts.recycledFiles = recycled.length
  if (apply)
    for (const row of recycled) {
      signal.throwIfAborted()
      await db.transaction(async (conn) => {
        await conn.query(
          'UPDATE file_uploads SET file_id=NULL WHERE file_id=$1',
          [row.id],
        )
        await conn.query(
          "UPDATE file_uploads SET previous_file_id=NULL,state=CASE WHEN state='completed' THEN state ELSE 'cancelled' END WHERE previous_file_id=$1",
          [row.id],
        )
        await conn.query('DELETE FROM file_migration_items WHERE file_id=$1', [
          row.id,
        ])
        await conn.query('DELETE FROM file_entries WHERE id=$1', [row.id])
        await conn.query(
          'DELETE FROM file_objects WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM file_entries WHERE object_id=$1)',
          [row.object_id],
        )
      })
    }
  // Only product-created object prefixes; old locations retained by migration receipts are excluded.
  for (const connection of await library.options.registry.list()) {
    const storage = await library.options.registry.get(text(connection.id))
    counts.incompleteUploads += await storage.cleanIncomplete(
      temporaryCutoff,
      apply,
    )
    for await (const item of storage.list('objects/')) {
      signal.throwIfAborted()
      if (item.modifiedAt >= temporaryCutoff) continue
      const used = await db.query(
        'SELECT id FROM file_objects WHERE storage_id=$1 AND object_key=$2',
        [connection.id, item.key],
      )
      const migrated = await db.query(
        'SELECT id FROM file_migration_items WHERE source_storage_id=$1 AND source_object_key=$2 LIMIT 1',
        [connection.id, item.key],
      )
      if (used.length || migrated.length) continue
      counts.orphanObjects++
      if (apply) await storage.remove(item.key)
    }
  }
  return counts
}
