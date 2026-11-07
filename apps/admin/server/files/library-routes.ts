import { pipeline } from 'node:stream/promises'
import {
  ApiError,
  integer,
  requiredText,
  text,
  type ApiRouter,
  type ApiContext,
} from '../http/api-router.ts'
import { FileLibrary } from './file-library.ts'
import { parseRange } from './object-storage.ts'

export async function sendLibraryFile(
  library: FileLibrary,
  owner: string,
  fileId: string,
  ctx: ApiContext,
) {
  const row = await library.row(owner, fileId)
  const size = Number(row.size)
  let range
  try {
    range = parseRange(ctx.request.headers.range, size)
  } catch (error) {
    ctx.response.setHeader('Content-Range', `bytes */${size}`)
    throw error
  }
  const storage = await library.options.registry.get(text(row.storage_id))
  let input
  try {
    input = await storage.read(text(row.object_key), range, ctx.signal)
  } catch {
    throw new ApiError(503, '文件存储暂时不可用，请检查存储连接后重试')
  }
  const mediaType = text(row.media_type, 'application/octet-stream')
  const inline =
    ctx.url.searchParams.get('inline') === 'true' &&
    /^(image\/(png|jpeg|webp|gif)|audio\/|video\/|application\/pdf|text\/plain)/.test(
      mediaType,
    )
  ctx.response.statusCode = range ? 206 : 200
  ctx.response.setHeader('Content-Type', mediaType)
  ctx.response.setHeader(
    'Content-Length',
    range ? range.end - range.start + 1 : size,
  )
  ctx.response.setHeader('Accept-Ranges', 'bytes')
  if (range)
    ctx.response.setHeader(
      'Content-Range',
      `bytes ${range.start}-${range.end}/${size}`,
    )
  ctx.response.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(text(row.name))}`,
  )
  ctx.response.setHeader('Cache-Control', 'private, no-store')
  ctx.response.setHeader('X-Content-Type-Options', 'nosniff')
  ctx.response.setHeader(
    'Content-Security-Policy',
    "sandbox; default-src 'none'; frame-ancestors 'self'",
  )
  await pipeline(input, ctx.response, { signal: ctx.signal })
}

export function registerFileLibraryRoutes(
  router: ApiRouter,
  library: FileLibrary,
  audit: (
    actor: string,
    action: string,
    target: string,
    detail?: Record<string, unknown>,
  ) => Promise<void>,
) {
  const read = { permission: 'files.read' },
    write = { permission: 'files.write' },
    manage = { permission: 'storage.manage' }
  router.add(
    'GET',
    '/files',
    (ctx) => library.list(ctx.account!.userId, ctx.url.searchParams),
    read,
  )
  router.add(
    'POST',
    '/files/uploads',
    (ctx) => library.begin(ctx.account!.userId, ctx.body),
    write,
  )
  router.add(
    'GET',
    '/files/uploads/{upload_id}',
    (ctx) => library.uploadStatus(ctx.account!.userId, ctx.params.upload_id!),
    read,
  )
  router.add(
    'PUT',
    '/files/uploads/{upload_id}/parts/{part}',
    (ctx) =>
      library.part(
        ctx.account!.userId,
        ctx.params.upload_id!,
        integer(ctx.params.part, 0, 1),
        ctx.request,
        ctx.signal,
      ),
    { ...write, rawBody: true },
  )
  router.add(
    'POST',
    '/files/uploads/{upload_id}/complete',
    async (ctx) => {
      const entry = await library.complete(
        ctx.account!.userId,
        ctx.params.upload_id!,
        ctx.signal,
      )
      await audit(ctx.account!.userId, 'file.upload.complete', entry.id)
      return entry
    },
    write,
  )
  router.add(
    'POST',
    '/files/uploads/{upload_id}/cancel',
    (ctx) => library.cancel(ctx.account!.userId, ctx.params.upload_id!),
    write,
  )
  router.add(
    'GET',
    '/files/{file_id}',
    (ctx) => library.entry(ctx.account!.userId, ctx.params.file_id!),
    read,
  )
  router.add(
    'GET',
    '/files/{file_id}/content',
    (ctx) =>
      sendLibraryFile(library, ctx.account!.userId, ctx.params.file_id!, ctx),
    read,
  )
  router.add(
    'GET',
    '/files/{file_id}/versions',
    async (ctx) => {
      let current = await library.entry(
        ctx.account!.userId,
        ctx.params.file_id!,
        true,
      )
      const items = [current]
      while (current.previousFileId && items.length < 100) {
        current = await library.entry(
          ctx.account!.userId,
          current.previousFileId,
          true,
        )
        items.push(current)
      }
      return { items }
    },
    read,
  )
  for (const action of ['trash', 'restore'] as const)
    router.add(
      'POST',
      `/files/{file_id}/${action}`,
      async (ctx) => {
        const entry = await library.trash(
          ctx.account!.userId,
          ctx.params.file_id!,
          action === 'restore',
        )
        await audit(ctx.account!.userId, 'file.' + action, entry.id)
        return entry
      },
      write,
    )
  router.add(
    'GET',
    '/admin/storage',
    async () => ({
      ...(await library.options.registry.settings()),
      connections: await library.options.registry.list(),
    }),
    manage,
  )
  router.add(
    'POST',
    '/admin/storage/connections',
    async (ctx) => {
      const result = await library.options.registry.save(undefined, ctx.body)
      await audit(
        ctx.account!.userId,
        'storage.connection.create',
        text(result.id),
      )
      return result
    },
    manage,
  )
  router.add(
    'PATCH',
    '/admin/storage/connections/{connection_id}',
    async (ctx) => {
      const result = await library.options.registry.save(
        ctx.params.connection_id!,
        ctx.body,
      )
      await audit(
        ctx.account!.userId,
        'storage.connection.update',
        text(result.id),
      )
      return result
    },
    manage,
  )
  router.add(
    'POST',
    '/admin/storage/connections/{connection_id}/check',
    async (ctx) => {
      try {
        await (
          await library.options.registry.get(ctx.params.connection_id!)
        ).check()
      } catch {
        throw new ApiError(503, '无法访问存储，请检查地址、Bucket 和凭据')
      }
      return { ok: true }
    },
    manage,
  )
  router.add(
    'PUT',
    '/admin/storage',
    async (ctx) => {
      const result = await library.options.registry.update(ctx.body)
      await audit(ctx.account!.userId, 'storage.settings.update', 'global')
      return result
    },
    manage,
  )
  router.add(
    'GET',
    '/admin/storage/usage',
    async () => ({
      items: await library.options.db.query(
        'SELECT storage_id,COUNT(*) AS objects,COALESCE(SUM(size),0) AS bytes FROM file_objects GROUP BY storage_id',
      ),
    }),
    manage,
  )
  router.add(
    'GET',
    '/admin/storage/migrations',
    async () => ({
      items: await library.options.db.query(
        'SELECT state,COUNT(*) AS total FROM file_migration_items GROUP BY state',
      ),
    }),
    manage,
  )
  router.add(
    'POST',
    '/files/{file_id}/migrate',
    async (ctx) => {
      await ctx.user('storage.manage')
      return library.migrate(
        ctx.account!.userId,
        ctx.params.file_id!,
        requiredText(ctx.body.targetConnectionId, '目标存储'),
        ctx.signal,
      )
    },
    write,
  )
}
