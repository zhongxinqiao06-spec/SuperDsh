import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type {
  Database,
  Row,
  SqlConnection,
} from '../infrastructure/database.ts'
import type {
  FileEntry,
  FileReference,
  FileUpload,
} from '@superdsh/core/contracts/platform'
import { StorageRegistry } from './storage-registry.ts'
import { officeUploadType } from './upload-content.ts'

export const uploadPartSize = 8 * 1024 * 1024
const id = (prefix: string) => prefix + '_' + randomUUID().replaceAll('-', '')
const publishedFile = `NOT EXISTS(SELECT 1 FROM file_legacy_mappings lm WHERE lm.file_id=e.id AND lm.kind='session' AND
  ((LEFT(lm.legacy_file_id,9)='artifact_' AND NOT EXISTS(SELECT 1 FROM business_agent_artifacts a WHERE a.id=lm.legacy_file_id AND a.session_id=lm.resource_id)) OR
   (LEFT(lm.legacy_file_id,8)='preview_' AND NOT EXISTS(SELECT 1 FROM business_agent_artifacts a WHERE a.session_id=lm.resource_id AND a.metadata_json::jsonb->'preview'->>'fileId'=lm.legacy_file_id))))`
const checksum = (value: unknown) => {
  const sha = requiredText(value, 'SHA-256', 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ApiError(422, 'SHA-256 格式不正确')
  return sha
}
const filename = (value: unknown) => {
  const name = requiredText(value, '文件名', 255).trim()
  if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..')
    throw new ApiError(422, '文件名不能包含路径')
  return name
}

/** Validate binary signatures; download never trusts a caller-supplied inline MIME. */
export function detectMediaType(
  bytes: Buffer,
  name: string,
  claimed: string,
): string {
  const starts = (hex: string) =>
    bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'))
  let actual: string | undefined
  if (starts('89504e470d0a1a0a')) actual = 'image/png'
  else if (starts('ffd8ff')) actual = 'image/jpeg'
  else if (bytes.subarray(0, 5).toString() === '%PDF-')
    actual = 'application/pdf'
  else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString()))
    actual = 'image/gif'
  else if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    actual = 'image/webp'
  else if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WAVE'
  )
    actual = 'audio/wav'
  else if (bytes.subarray(0, 4).toString() === 'OggS') actual = 'audio/ogg'
  else if (
    bytes.subarray(0, 3).toString() === 'ID3' ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  )
    actual = 'audio/mpeg'
  else if (bytes.subarray(4, 8).toString() === 'ftyp')
    actual = /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/mp4'
  else if (starts('504b0304')) {
    const types: Record<string, string> = {
      docx: 'wordprocessingml.document',
      pptx: 'presentationml.presentation',
      xlsx: 'spreadsheetml.sheet',
    }
    const extension = name.split('.').at(-1)?.toLowerCase() || ''
    actual = types[extension]
      ? 'application/vnd.openxmlformats-officedocument.' + types[extension]
      : 'application/zip'
  }
  if (actual) {
    if (
      claimed &&
      claimed !== 'application/octet-stream' &&
      claimed.split(';')[0] !== actual
    )
      throw new ApiError(422, '文件类型与实际内容不一致')
    return actual
  }
  if (/^(image\/|audio\/|video\/|application\/pdf)/.test(claimed))
    throw new ApiError(422, '无法识别文件的实际格式')
  return /\.(txt|md|csv|json)$/i.test(name) && !bytes.includes(0)
    ? 'text/plain'
    : 'application/octet-stream'
}

export class FileLibrary {
  readonly options: {
    db: Database
    registry: StorageRegistry
    stagingDirectory: string
  }
  constructor(options: FileLibrary['options']) {
    this.options = options
  }
  private async upload(owner: string, uploadId: string) {
    const [row] = await this.options.db.query(
      'SELECT * FROM file_uploads WHERE id=$1 AND owner_user_id=$2',
      [uploadId, owner],
    )
    if (!row) throw new ApiError(404, '上传记录不存在')
    return row
  }
  async uploadStatus(owner: string, uploadId: string): Promise<FileUpload> {
    const row = await this.upload(owner, uploadId)
    const parts = await this.options.db.query(
      'SELECT part_number FROM file_upload_parts WHERE upload_id=$1 ORDER BY part_number',
      [uploadId],
    )
    return {
      id: uploadId,
      state: row.state as FileUpload['state'],
      partSize: uploadPartSize,
      receivedParts: parts.map((part) => Number(part.part_number)),
      expiresAt: text(row.expires_at),
      fileId: text(row.file_id) || undefined,
    }
  }
  async begin(owner: string, body: Row) {
    const settings = await this.options.registry.settings()
    const name = filename(body.name),
      size = integer(body.size, -1, 1, settings.policy.maxFileBytes),
      sha = checksum(body.sha256)
    const key = requiredText(body.idempotencyKey, '上传幂等标识', 160)
    const previous = text(body.previousFileId) || null
    if (previous) await this.entry(owner, previous)
    const uploadId = id('upload')
    const rows = await this.options.db.query(
      `INSERT INTO file_uploads(id,owner_user_id,idempotency_key,name,size,sha256,media_type,storage_id,state,previous_file_id,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'receiving',$9,$10,$11) ON CONFLICT(owner_user_id,idempotency_key) DO NOTHING RETURNING id`,
      [
        uploadId,
        owner,
        key,
        name,
        size,
        sha,
        text(body.mediaType, 'application/octet-stream'),
        settings.activeConnectionId,
        previous,
        utcNow(),
        new Date(
          Date.now() + settings.policy.temporaryHours * 3600_000,
        ).toISOString(),
      ],
    )
    if (!rows.length) {
      const [old] = await this.options.db.query(
        'SELECT * FROM file_uploads WHERE owner_user_id=$1 AND idempotency_key=$2',
        [owner, key],
      )
      if (
        old!.name !== name ||
        Number(old!.size) !== size ||
        old!.sha256 !== sha ||
        (old!.previous_file_id || null) !== previous
      )
        throw new ApiError(409, '上传标识已用于不同文件')
      return this.uploadStatus(owner, text(old!.id))
    }
    return this.uploadStatus(owner, uploadId)
  }
  async part(
    owner: string,
    uploadId: string,
    number: number,
    input: Readable,
    signal: AbortSignal,
  ) {
    const upload = await this.upload(owner, uploadId)
    if (upload.state !== 'receiving' || text(upload.expires_at) < utcNow())
      throw new ApiError(409, '上传已关闭或过期')
    const count = Math.max(1, Math.ceil(Number(upload.size) / uploadPartSize))
    integer(number, 0, 1, count)
    const expected =
      number === count
        ? Number(upload.size) - (number - 1) * uploadPartSize
        : uploadPartSize
    await mkdir(this.options.stagingDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.options.stagingDirectory, id('part'))
    const hash = createHash('sha256')
    let size = 0,
      retained = false
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > expected)
          return callback(new ApiError(413, '上传分片超过预期大小'))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        input,
        meter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal },
      )
      if (size !== expected) throw new ApiError(422, '上传分片大小不一致')
      const sha = hash.digest('hex')
      await this.options.db.transaction(async (db) => {
        const [current] = await db.query(
          'SELECT state,expires_at FROM file_uploads WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
          [uploadId, owner],
        )
        if (
          current?.state !== 'receiving' ||
          text(current.expires_at) < utcNow()
        )
          throw new ApiError(409, '上传已关闭')
        const [old] = await db.query(
          'SELECT * FROM file_upload_parts WHERE upload_id=$1 AND part_number=$2',
          [uploadId, number],
        )
        if (old) {
          if (old.sha256 !== sha)
            throw new ApiError(409, '已上传分片内容不同，请重新创建上传')
          return
        }
        await db.query(
          'INSERT INTO file_upload_parts(upload_id,part_number,path,size,sha256) VALUES($1,$2,$3,$4,$5)',
          [uploadId, number, path, size, sha],
        )
        retained = true
      })
      return this.uploadStatus(owner, uploadId)
    } finally {
      if (!retained) await unlink(path).catch(() => {})
    }
  }
  async complete(
    owner: string,
    uploadId: string,
    signal: AbortSignal,
  ): Promise<FileEntry> {
    const lease = await this.options.db.lease('file-upload:' + uploadId)
    if (!lease) throw new ApiError(409, '文件正在校验，请查询上传状态')
    const abort = new AbortController()
    void lease.lost.then(() => abort.abort(new Error('Upload ownership lost')))
    const combined = AbortSignal.any([signal, abort.signal])
    let storage: Awaited<ReturnType<StorageRegistry['get']>> | undefined
    let key: string | undefined,
      committed = false
    try {
      const upload = await this.upload(owner, uploadId)
      if (upload.state === 'completed')
        return this.entry(owner, text(upload.file_id))
      if (upload.state === 'cancelled' || text(upload.expires_at) < utcNow())
        throw new ApiError(409, '上传已关闭或过期')
      const parts = await this.options.db.transaction(async (db) => {
        const [current] = await db.query(
          'SELECT state FROM file_uploads WHERE id=$1 FOR UPDATE',
          [uploadId],
        )
        if (current?.state === 'cancelled')
          throw new ApiError(409, '上传已取消')
        const items = await db.query(
          'SELECT * FROM file_upload_parts WHERE upload_id=$1 ORDER BY part_number',
          [uploadId],
        )
        if (
          items.length !==
          Math.max(1, Math.ceil(Number(upload.size) / uploadPartSize))
        )
          throw new ApiError(409, '文件分片尚未上传完整')
        await db.query(
          "UPDATE file_uploads SET state='completing' WHERE id=$1",
          [uploadId],
        )
        return items
      })
      const hash = createHash('sha256'),
        header: Buffer[] = []
      let size = 0,
        headerBytes = 0
      for (const part of parts) {
        for await (const chunk of createReadStream(text(part.path), {
          signal: combined,
        })) {
          const buffer = Buffer.from(chunk)
          hash.update(buffer)
          size += buffer.length
          if (headerBytes < 512) {
            const sample = buffer.subarray(0, 512 - headerBytes)
            header.push(sample)
            headerBytes += sample.length
          }
        }
      }
      if (size !== Number(upload.size) || hash.digest('hex') !== upload.sha256)
        throw new ApiError(422, '文件大小或 SHA-256 校验失败')
      const sample = Buffer.concat(header)
      const mediaType = sample
        .subarray(0, 4)
        .equals(Buffer.from('504b0304', 'hex'))
        ? await officeUploadType(
            parts.map((part) => ({
              path: text(part.path),
              size: Number(part.size),
            })),
            size,
            text(upload.name),
            text(upload.media_type),
            combined,
          )
        : detectMediaType(sample, text(upload.name), text(upload.media_type))
      storage = await this.options.registry.get(text(upload.storage_id), true)
      key = 'objects/' + id('blob')
      async function* contents() {
        for (const part of parts)
          yield* createReadStream(text(part.path), { signal: combined })
      }
      await storage.write(
        key,
        Readable.from(contents()),
        size,
        mediaType,
        combined,
      )
      combined.throwIfAborted()
      const entryId = id('file')
      await this.options.db.transaction(async (db) => {
        const [current] = await db.query(
          'SELECT state FROM file_uploads WHERE id=$1 FOR UPDATE',
          [uploadId],
        )
        if (current?.state !== 'completing')
          throw new ApiError(409, '上传已取消')
        await this.insert(db, owner, entryId, {
          storageId: text(upload.storage_id),
          key: key!,
          name: text(upload.name),
          size,
          sha256: text(upload.sha256),
          mediaType,
          previousFileId: text(upload.previous_file_id) || undefined,
        })
        await db.query(
          "UPDATE file_uploads SET state='completed',file_id=$2 WHERE id=$1",
          [uploadId, entryId],
        )
      })
      committed = true
      for (const part of parts) await unlink(text(part.path)).catch(() => {})
      return this.entry(owner, entryId)
    } catch (error) {
      await this.options.db.query(
        "UPDATE file_uploads SET state='receiving' WHERE id=$1 AND owner_user_id=$2 AND state='completing'",
        [uploadId, owner],
      )
      throw error
    } finally {
      if (key && storage && !committed)
        await storage.remove(key).catch(() => {})
      await lease.release()
    }
  }
  async cancel(owner: string, uploadId: string) {
    const upload = await this.upload(owner, uploadId)
    if (upload.state === 'completed') throw new ApiError(409, '文件已完成上传')
    await this.options.db.query(
      "UPDATE file_uploads SET state='cancelled' WHERE id=$1 AND owner_user_id=$2 AND state<>'completed'",
      [uploadId, owner],
    )
    return this.uploadStatus(owner, uploadId)
  }
  private async insert(
    db: SqlConnection,
    owner: string,
    entryId: string,
    item: {
      storageId: string
      key: string
      name: string
      size: number
      sha256: string
      mediaType: string
      previousFileId?: string
    },
  ) {
    let version = 1
    if (item.previousFileId) {
      const [previous] = await db.query(
        'SELECT version FROM file_entries WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [item.previousFileId, owner],
      )
      if (!previous) throw new ApiError(404, '原文件不存在')
      version = Number(previous.version) + 1
    }
    const objectId = id('object'),
      now = utcNow()
    await db.query(
      'INSERT INTO file_objects(id,storage_id,object_key,size,sha256,media_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        objectId,
        item.storageId,
        item.key,
        item.size,
        item.sha256,
        item.mediaType,
        now,
      ],
    )
    const category = item.mediaType.startsWith('image/')
      ? 'image'
      : item.mediaType.startsWith('audio/')
        ? 'audio'
        : item.mediaType.startsWith('video/')
          ? 'video'
          : /text|pdf|officedocument/.test(item.mediaType)
            ? 'document'
            : 'other'
    await db.query(
      'INSERT INTO file_entries(id,owner_user_id,object_id,name,category,version,previous_file_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        entryId,
        owner,
        objectId,
        item.name,
        category,
        version,
        item.previousFileId || null,
        now,
      ],
    )
  }
  async ingest(
    owner: string,
    name: string,
    data: Buffer,
    mediaType: string,
    reference?: Omit<FileReference, 'fileId'>,
    register?: (db: SqlConnection, fileId: string) => Promise<void>,
  ): Promise<FileEntry> {
    const settings = await this.options.registry.settings()
    const storage = await this.options.registry.get(
      settings.activeConnectionId,
      true,
    )
    const key = 'objects/' + id('blob'),
      entryId = id('file')
    await storage.write(key, Readable.from([data]), data.length, mediaType)
    try {
      await this.options.db.transaction(async (db) => {
        await this.insert(db, owner, entryId, {
          storageId: settings.activeConnectionId,
          key,
          name: filename(name),
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          mediaType,
        })
        if (reference)
          await db.query(
            'INSERT INTO file_references(file_id,kind,resource_id,created_at) VALUES($1,$2,$3,$4)',
            [entryId, reference.kind, reference.resourceId, utcNow()],
          )
        await register?.(db, entryId)
      })
    } catch (error) {
      await storage.remove(key).catch(() => {})
      throw error
    }
    if (!register) return this.entry(owner, entryId)
    return {
      id: entryId,
      name,
      mediaType,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      category: mediaType.startsWith('image/') ? 'image' : 'document',
      version: 1,
      createdAt: utcNow(),
      references: reference ? [{ ...reference, fileId: entryId }] : [],
    }
  }
  async row(owner: string, fileId: string, trash = false) {
    const [row] = await this.options.db.query(
      `SELECT e.*,o.storage_id,o.object_key,o.size,o.sha256,o.media_type FROM file_entries e JOIN file_objects o ON o.id=e.object_id WHERE e.id=$1 AND e.owner_user_id=$2 AND ${publishedFile} ${trash ? '' : 'AND e.deleted_at IS NULL'}`,
      [fileId, owner],
    )
    if (!row) throw new ApiError(404, '文件不存在或无权访问')
    return row
  }
  async entry(
    owner: string,
    fileId: string,
    trash = false,
  ): Promise<FileEntry> {
    const row = await this.row(owner, fileId, trash)
    const references = await this.options.db.query(
      'SELECT kind,resource_id FROM file_references WHERE file_id=$1',
      [fileId],
    )
    return {
      id: fileId,
      name: text(row.name),
      mediaType: text(row.media_type),
      size: Number(row.size),
      sha256: text(row.sha256),
      category: row.category as FileEntry['category'],
      version: Number(row.version),
      previousFileId: text(row.previous_file_id) || undefined,
      deletedAt: text(row.deleted_at) || undefined,
      createdAt: text(row.created_at),
      references: references.map((ref) => ({
        fileId,
        kind: ref.kind as FileReference['kind'],
        resourceId: text(ref.resource_id),
      })),
    }
  }
  async list(owner: string, query: URLSearchParams) {
    const page = integer(query.get('page'), 1, 1),
      pageSize = integer(query.get('pageSize'), 10, 1, 50)
    if (![10, 20, 50].includes(pageSize))
      throw new ApiError(422, '分页数量仅支持 10、20、50')
    const where = `owner_user_id=$1 AND ${publishedFile} AND deleted_at IS ${query.get('trash') === 'true' ? 'NOT ' : ''}NULL AND name ILIKE $2 AND ($3='' OR category=$3)`
    const values = [
      owner,
      '%' + (query.get('q') || '').slice(0, 200) + '%',
      query.get('category') || '',
    ]
    const [count] = await this.options.db.query(
      `SELECT COUNT(*) AS total FROM file_entries e WHERE ${where}`,
      values,
    )
    const rows = await this.options.db.query(
      `SELECT id FROM file_entries e WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
      [...values, pageSize, (page - 1) * pageSize],
    )
    return {
      items: await Promise.all(
        rows.map((row) => this.entry(owner, text(row.id), true)),
      ),
      total: Number(count!.total),
      page,
      pageSize,
    }
  }
  async trash(owner: string, fileId: string, restore = false) {
    await this.options.db.transaction(async (db) => {
      const [entry] = await db.query(
        'SELECT id FROM file_entries WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
        [fileId, owner],
      )
      if (!entry) throw new ApiError(404, '文件不存在')
      if (!restore) {
        const refs = await db.query(
          'SELECT file_id FROM file_references WHERE file_id=$1 LIMIT 1',
          [fileId],
        )
        if (refs.length)
          throw new ApiError(409, '文件仍被会话、知识或成果引用，请先解除引用')
      }
      await db.query('UPDATE file_entries SET deleted_at=$2 WHERE id=$1', [
        fileId,
        restore ? null : utcNow(),
      ])
    })
    return this.entry(owner, fileId, true)
  }
  async readBuffer(owner: string, fileId: string, maximum = 32 * 1024 * 1024) {
    const row = await this.row(owner, fileId)
    if (Number(row.size) > maximum)
      throw new ApiError(413, '文件超过当前工具处理上限')
    const input = await (
      await this.options.registry.get(text(row.storage_id))
    ).read(text(row.object_key))
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maximum) {
        input.destroy()
        throw new ApiError(413, '文件超过当前工具处理上限')
      }
      chunks.push(bytes)
    }
    const content = Buffer.concat(chunks)
    if (
      content.length !== Number(row.size) ||
      createHash('sha256').update(content).digest('hex') !== row.sha256
    )
      throw new ApiError(502, '存储内容校验失败')
    return { content, entry: await this.entry(owner, fileId) }
  }
  async migrate(
    owner: string,
    fileId: string,
    targetId: string,
    signal: AbortSignal,
  ) {
    const lease = await this.options.db.lease('file-migrate:' + fileId)
    if (!lease) throw new ApiError(409, '文件正在迁移')
    const controller = new AbortController()
    void lease.lost.then((error) => controller.abort(error))
    signal = AbortSignal.any([signal, controller.signal])
    try {
      const row = await this.row(owner, fileId, true)
      if (row.storage_id === targetId) return this.entry(owner, fileId, true)
      const target = await this.options.registry.get(targetId, true)
      const key = 'objects/' + text(row.object_id)
      await this.options.db.query(
        `INSERT INTO file_migration_items(id,file_id,source_storage_id,target_storage_id,state,updated_at,source_object_key) VALUES($1,$2,$3,$4,'copying',$5,$6)
        ON CONFLICT(file_id,target_storage_id) DO UPDATE SET state='copying',error=NULL,updated_at=$5`,
        [
          id('migration'),
          fileId,
          row.storage_id,
          targetId,
          utcNow(),
          row.object_key,
        ],
      )
      const source = await this.options.registry.get(text(row.storage_id))
      await target.write(
        key,
        await source.read(text(row.object_key), undefined, signal),
        Number(row.size),
        text(row.media_type),
        signal,
      )
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of await target.read(key, undefined, signal)) {
        const bytes = Buffer.from(chunk)
        hash.update(bytes)
        size += bytes.length
      }
      if (size !== Number(row.size) || hash.digest('hex') !== row.sha256)
        throw new ApiError(502, '迁移文件校验失败，原文件保持不变')
      await this.options.db.transaction(async (db) => {
        signal.throwIfAborted()
        await db.query(
          'UPDATE file_objects SET storage_id=$2,object_key=$3 WHERE id=$1 AND storage_id=$4',
          [row.object_id, targetId, key, row.storage_id],
        )
        await db.query(
          "UPDATE file_migration_items SET state='completed',updated_at=$3 WHERE file_id=$1 AND target_storage_id=$2",
          [fileId, targetId, utcNow()],
        )
      })
      return this.entry(owner, fileId, true)
    } catch (error) {
      await this.options.db.query(
        "UPDATE file_migration_items SET state='failed',error='迁移未完成，源文件已保留',updated_at=$3 WHERE file_id=$1 AND target_storage_id=$2",
        [fileId, targetId, utcNow()],
      )
      throw error
    } finally {
      await lease.release()
    }
  }
  async legacy(kind: string, resource: string, legacyFileId: string) {
    const [mapping] = await this.options.db.query(
      'SELECT l.file_id,e.owner_user_id FROM file_legacy_mappings l JOIN file_entries e ON e.id=l.file_id WHERE l.kind=$1 AND l.resource_id=$2 AND l.legacy_file_id=$3',
      [kind, resource, legacyFileId],
    )
    return mapping
  }
  async linkRevision(owner: string, fileId: string, previousFileId: string) {
    if (fileId === previousFileId)
      throw new ApiError(409, '文件版本不能引用自身')
    await this.options.db.transaction(async (db) => {
      const rows = await db.query(
        `SELECT e.id,e.version,e.previous_file_id,${publishedFile} AS published FROM file_entries e WHERE e.owner_user_id=$1 AND e.id=ANY($2::text[]) AND e.deleted_at IS NULL ORDER BY e.id FOR UPDATE`,
        [owner, [fileId, previousFileId]],
      )
      const current = rows.find((row) => row.id === fileId),
        previous = rows.find((row) => row.id === previousFileId)
      if (!current || !previous)
        throw new ApiError(404, '文件版本不存在或无权访问')
      if (current.previous_file_id === previousFileId) return
      if (
        current.published ||
        !previous.published ||
        current.previous_file_id ||
        Number(current.version) !== 1 ||
        (
          await db.query(
            'SELECT id FROM file_entries WHERE previous_file_id=$1 LIMIT 1',
            [fileId],
          )
        ).length
      )
        throw new ApiError(409, '已发布版本关系不可更改')
      await db.query(
        'UPDATE file_entries SET previous_file_id=$2,version=$3 WHERE id=$1',
        [fileId, previousFileId, Number(previous.version) + 1],
      )
    })
  }
  async nextMigrationEntry(after: string) {
    const [entry] = await this.options.db.query(
      `SELECT e.id,e.owner_user_id FROM file_entries e WHERE e.id>$1 AND ${publishedFile} ORDER BY e.id LIMIT 1`,
      [after],
    )
    return entry
  }
  async attach(owner: string, fileId: string, session: string) {
    const file = await this.entry(owner, fileId)
    await this.options.db.transaction(async (db) => {
      const [entry] = await db.query(
        'SELECT id FROM file_entries WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [fileId, owner],
      )
      if (!entry) throw new ApiError(404, '文件不存在')
      await db.query(
        "INSERT INTO file_legacy_mappings(kind,resource_id,legacy_file_id,file_id,created_at) VALUES('session',$1,$2,$2,$3) ON CONFLICT DO NOTHING",
        [session, fileId, utcNow()],
      )
      await db.query(
        "INSERT INTO file_references(file_id,kind,resource_id,created_at) VALUES($1,'session',$2,$3) ON CONFLICT DO NOTHING",
        [fileId, session, utcNow()],
      )
    })
    return {
      fileId,
      libraryFileId: fileId,
      sessionId: session,
      name: file.name,
      size: file.size,
      mediaType: file.mediaType,
      sha256: file.sha256,
      origin: 'user',
      downloadUrl: `/api/v2/sessions/${session}/attachments/${fileId}`,
      openUrl: `/api/v2/sessions/${session}/attachments/${fileId}/open`,
    }
  }
  async saveLegacy(
    owner: string,
    kind: 'session' | 'knowledge' | 'template',
    resource: string,
    legacyFileId: string,
    name: string,
    content: Buffer,
    mediaType: string,
  ) {
    const lease = await this.options.db.lease(
      'file-import:' +
        createHash('sha256')
          .update(JSON.stringify([kind, resource, legacyFileId]))
          .digest('hex'),
    )
    if (!lease) throw new ApiError(409, '文件正在保存，请稍后重试')
    try {
      const existing = await this.legacy(kind, resource, legacyFileId)
      if (existing) {
        const [row] = await this.options.db.query(
          'SELECT o.sha256 FROM file_entries e JOIN file_objects o ON o.id=e.object_id WHERE e.id=$1 AND e.owner_user_id=$2',
          [existing.file_id, owner],
        )
        if (
          !row ||
          row.sha256 !== createHash('sha256').update(content).digest('hex')
        )
          throw new ApiError(409, '历史文件标识不可覆盖，请保存新版本')
        return text(existing.file_id)
      }
      const entry = await this.ingest(
        owner,
        name,
        content,
        mediaType,
        { kind, resourceId: resource },
        async (db, fileId) => {
          await db.query(
            'INSERT INTO file_legacy_mappings(kind,resource_id,legacy_file_id,file_id,created_at) VALUES($1,$2,$3,$4,$5)',
            [kind, resource, legacyFileId, fileId, utcNow()],
          )
        },
      )
      return entry.id
    } finally {
      await lease.release()
    }
  }
}
