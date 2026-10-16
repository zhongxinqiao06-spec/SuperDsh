import { createHash } from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket from 'ws'
import {
  ApiError,
  bearer,
  integer,
  object,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import type { ApiContext, ApiRouter } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import { json } from '../infrastructure/database.ts'
import {
  hashToken,
  identifier,
  record,
  requirePermission,
} from '../conversations/store.ts'
import type { ConnectorHub } from '../devices/connector-hub.ts'
import { createFileStorage } from './storage.ts'
import type { FileStorage } from './storage.ts'

interface Access {
  token: string
  userId: string
  connectorId?: string
  sessionId?: string
  fileId?: string
  root?: string
  path?: string
  expires: number
  consumed?: boolean
}
interface Transfer {
  connectorId: string
  userId: string
  sessionId: string
  token: string
  accessToken: string
  expires: number
  data?: Buffer
  stream?: PassThrough
  openStream?: () => Readable
  metadata: Row
  resolve(): void
  ready: Promise<void>
}
interface Relay {
  connectorId: string
  terminalId: string
  socket: WebSocket
  pending: Map<
    string,
    { resolve(value: Row): void; reject(error: Error): void }
  >
}
interface RelayAccess {
  token: string
  connectorId: string
  sessionId: string
  terminalId: string
  root: string
  cwd: string
  expires: number
}
const safeId = (value: string): string => {
  if (!/^[\w-]{1,200}$/.test(value)) throw new ApiError(404, 'file not found')
  return value
}
export function resolveRemotePath(root: string, value: string): string {
  const platform =
    /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')
      ? path.win32
      : path.posix
  const target = platform.resolve(root, value),
    relative = platform.relative(platform.resolve(root), target)
  if (
    relative === '..' ||
    relative.startsWith(`..${platform.sep}`) ||
    platform.isAbsolute(relative)
  )
    throw new ApiError(403, 'path is outside the selected workspace')
  return target
}
async function bodyBytes(
  request: IncomingMessage,
  max = 64 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > max) throw new ApiError(413, 'file is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
export class FileService {
  readonly hub: ConnectorHub
  readonly root: string
  readonly storage: FileStorage
  readonly accesses = new Map<string, Access>()
  readonly transfers = new Map<string, Transfer>()
  readonly relays = new Map<string, Relay>()
  readonly relayAccess = new Map<string, RelayAccess>()
  readonly websocketPaths = [
    '/api/v2/connector/terminals/{terminal_id}/relay',
    '/api/v2/connectors/{connector_id}/terminals/{terminal_id}/stream',
    '/api/v2/connectors/{connector_id}/terminals-v2/{terminal_id}/stream',
    '/api/v2/sessions/{session_id}/terminals/{terminal_id}/stream',
  ]
  constructor(
    hub: ConnectorHub,
    root: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.hub = hub
    this.root = path.resolve(root)
    this.storage = createFileStorage(this.root, environment)
  }
  async read(
    sessionId: string,
    fileId: string,
  ): Promise<{ data: Buffer; metadata: Row }> {
    let data: Buffer, metadata: Row
    try {
      ;({ data, metadata } = await this.storage.read(
        safeId(sessionId),
        safeId(fileId),
      ))
    } catch {
      throw new ApiError(404, 'file not found')
    }
    if (
      metadata.size !== data.length ||
      metadata.sha256 !== createHash('sha256').update(data).digest('hex')
    )
      throw new ApiError(500, 'stored file metadata does not match content')
    return { data, metadata }
  }
  async downloadAttachment(
    connectorId: string,
    sessionId: string,
    fileId: string,
  ): Promise<{ content: Buffer; mediaType: string; name: string }> {
    await this.hub.connectorAllowed(connectorId)
    const session = await this.hub.store.session(sessionId)
    if (session.connector_id !== connectorId)
      throw new ApiError(404, 'attachment not found')
    const { data, metadata } = await this.read(sessionId, fileId)
    return {
      content: data,
      mediaType: text(metadata.mediaType, 'application/octet-stream'),
      name: text(metadata.name, fileId),
    }
  }
  async save(
    userId: string,
    sessionId: string,
    name: string,
    data: Buffer,
    mediaType = 'application/octet-stream',
    fileId = identifier('file'),
  ): Promise<Row> {
    await this.hub.store.session(sessionId, userId)
    if (data.length > 32 * 1024 * 1024)
      throw new ApiError(413, 'attachment is too large')
    const metadata = {
      fileId: safeId(fileId),
      sessionId,
      path: '',
      name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      mediaType,
      origin: 'user',
      createdAt: utcNow(),
    }
    await this.storage.write(safeId(sessionId), safeId(fileId), data, metadata)
    return {
      ...metadata,
      downloadUrl: `/api/v2/sessions/${sessionId}/attachments/${fileId}`,
      openUrl: `/api/v2/sessions/${sessionId}/attachments/${fileId}/open`,
    }
  }
  async stage(
    userId: string,
    sessionId: string,
    attachments: Row[],
  ): Promise<Row[]> {
    if (attachments.length > 10) throw new ApiError(413, 'too many attachments')
    const output: Row[] = []
    for (const attachment of attachments) {
      const fileId = requiredText(attachment.fileId, 'fileId', 64)
      let metadata: Row
      if (typeof attachment.contentBase64 === 'string') {
        const encoded = attachment.contentBase64
        if (
          !encoded ||
          encoded.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(encoded)
        )
          throw new ApiError(422, 'attachment contentBase64 is invalid')
        const data = Buffer.from(encoded, 'base64')
        if (data.toString('base64') !== encoded)
          throw new ApiError(422, 'attachment contentBase64 is invalid')
        if (attachment.size != null && attachment.size !== data.length)
          throw new ApiError(422, 'attachment size does not match content')
        if (
          attachment.sha256 != null &&
          attachment.sha256 !== createHash('sha256').update(data).digest('hex')
        )
          throw new ApiError(422, 'attachment sha256 does not match content')
        metadata = await this.save(
          userId,
          sessionId,
          requiredText(attachment.name, 'attachment name', 512),
          data,
          text(attachment.mediaType, 'application/octet-stream'),
          fileId,
        )
      } else {
        await this.hub.store.session(sessionId, userId)
        metadata = (await this.read(sessionId, fileId)).metadata
      }
      output.push({
        fileId,
        name: metadata.name,
        mediaType: metadata.mediaType,
        size: metadata.size,
        sha256: metadata.sha256,
        downloadUrl: `/api/v2/connector/sessions/${sessionId}/attachments/${fileId}/content`,
        platformOpenUrl: `/api/v2/sessions/${sessionId}/attachments/${fileId}/open`,
      })
    }
    return output
  }
  private issue(
    access: Omit<Access, 'expires'>,
    milliseconds = 300000,
  ): { token: string; expiresAt: string } {
    for (const [key, item] of this.accesses)
      if (item.expires < Date.now()) this.accesses.delete(key)
    const token = identifier('access'),
      expires = Date.now() + milliseconds
    this.accesses.set(hashToken(token), { ...access, expires, consumed: false })
    return { token, expiresAt: new Date(expires).toISOString() }
  }
  private async access(
    token: string,
    permission: string,
    consume = false,
  ): Promise<Access> {
    const item = this.accesses.get(hashToken(token))
    if (!item || item.expires < Date.now() || item.consumed)
      throw new ApiError(401, 'file access expired')
    const account = await this.hub.options.authenticateToken(item.token)
    requirePermission(account, permission)
    if (account.userId !== item.userId)
      throw new ApiError(401, 'invalid file access')
    if (item.connectorId) {
      await this.hub.store.connector(item.connectorId, account.userId)
      await this.hub.connectorAllowed(item.connectorId)
    }
    if (item.sessionId)
      await this.hub.store.session(item.sessionId, account.userId)
    if (consume) item.consumed = true
    return item
  }
  private send(
    response: ServerResponse,
    data: Buffer,
    metadata: Row,
    inline = false,
  ): void {
    this.fileHeaders(response, metadata, inline)
    response.setHeader('content-length', data.length)
    response.end(data)
  }
  private fileHeaders(
    response: ServerResponse,
    metadata: Row,
    inline = false,
  ): void {
    const mediaType = text(
      metadata.mediaType,
      'application/octet-stream',
    ).replace(/[\r\n]/g, '')
    const safePreview =
      /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)(?:;|$)/i.test(
        mediaType,
      )
    response.setHeader('content-type', mediaType)
    response.setHeader(
      'content-disposition',
      `${inline && safePreview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(text(metadata.name, 'download'))}`,
    )
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader(
      'content-security-policy',
      "sandbox; default-src 'none'; frame-ancestors 'self'",
    )
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('cache-control', 'private, no-store')
  }
  register(router: ApiRouter): void {
    const { hub } = this,
      { store } = hub,
      db = store.db
    const ownConnector = async (ctx: ApiContext) => {
      const row = await store.connector(
        ctx.params.connector_id!,
        ctx.account!.userId,
      )
      await hub.connectorAllowed(text(row.id))
      return row
    }
    router.add(
      'POST',
      '/sessions/{session_id}/attachments',
      async (ctx) => {
        await store.session(ctx.params.session_id!, ctx.account!.userId)
        const bytes = await bodyBytes(ctx.request)
        const contentType = ctx.request.headers['content-type'] || ''
        if (!contentType.startsWith('multipart/form-data'))
          throw new ApiError(415, 'multipart/form-data required')
        const form = await new Response(new Uint8Array(bytes), {
          headers: { 'content-type': contentType },
        }).formData()
        const attachments: Row[] = []
        for (const value of form.values())
          if (typeof value !== 'string') {
            if (attachments.length >= 10)
              throw new ApiError(413, 'too many attachments')
            attachments.push(
              await this.save(
                ctx.account!.userId,
                ctx.params.session_id!,
                value.name,
                Buffer.from(await value.arrayBuffer()),
                value.type || 'application/octet-stream',
              ),
            )
          }
        return { attachments, serverTime: utcNow() }
      },
      { permission: 'files.write', rawBody: true },
    )
    router.add(
      'GET',
      '/sessions/{session_id}/attachments/{file_id}',
      async (ctx) => {
        await store.session(ctx.params.session_id!, ctx.account!.userId)
        const { data, metadata } = await this.read(
          ctx.params.session_id!,
          ctx.params.file_id!,
        )
        return {
          ...metadata,
          contentBase64: data.toString('base64'),
          serverTime: utcNow(),
        }
      },
      { permission: 'files.read' },
    )
    router.add(
      'GET',
      '/sessions/{session_id}/attachments/{file_id}/open',
      async (ctx) => {
        const token =
            bearer(ctx.request) || ctx.url.searchParams.get('token') || '',
          account = await hub.options.authenticateToken(token)
        requirePermission(account, 'files.read')
        await store.session(ctx.params.session_id!, account.userId)
        await this.read(ctx.params.session_id!, ctx.params.file_id!)
        const access = this.issue({
          token,
          userId: account.userId,
          sessionId: ctx.params.session_id,
          fileId: ctx.params.file_id,
        })
        ctx.response.statusCode = 302
        ctx.response.setHeader(
          'location',
          `/api/v2/sessions/local/${ctx.params.session_id}/${ctx.params.file_id}?token=${access.token}`,
        )
        ctx.response.end()
      },
      { public: true },
    )
    router.add(
      'GET',
      '/sessions/local/{session_id}/{file_id}',
      async (ctx) => {
        const access = await this.access(
          ctx.url.searchParams.get('token') || '',
          'files.read',
        )
        if (
          access.sessionId !== ctx.params.session_id ||
          access.fileId !== ctx.params.file_id
        )
          throw new ApiError(404, 'file not found')
        const { data, metadata } = await this.read(
          ctx.params.session_id!,
          ctx.params.file_id!,
        )
        this.send(ctx.response, data, metadata, true)
      },
      { public: true },
    )
    router.add(
      'GET',
      '/connector/sessions/{session_id}/attachments/{file_id}/content',
      async (ctx) => {
        const identity = await hub.authenticateConnector(bearer(ctx.request)),
          file = await this.downloadAttachment(
            identity.id,
            ctx.params.session_id!,
            ctx.params.file_id!,
          )
        this.send(ctx.response, file.content, {
          name: file.name,
          mediaType: file.mediaType,
        })
      },
      { public: true },
    )
    router.add(
      'GET',
      '/public/shares/{share_id}/attachments/{file_id}',
      async (ctx) => {
        const [share] = await db.query(
          'SELECT s.* FROM session_shares s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.disabled=0 AND u.deleted_at IS NULL',
          [ctx.params.share_id],
        )
        if (
          !share ||
          !json<string[]>(share.allowed_file_ids_json, []).includes(
            ctx.params.file_id!,
          )
        )
          throw new ApiError(404, 'file not found')
        const { data, metadata } = await this.read(
          text(share.session_id),
          ctx.params.file_id!,
        )
        this.send(ctx.response, data, metadata, true)
      },
      { public: true },
    )
    for (const [route, method] of [
      ['list', 'fs.readDir'],
      ['readText', 'fs.readText'],
      ['write', 'fs.writeFile'],
    ])
      router.add(
        'POST',
        `/connectors/{connector_id}/fs/${route}`,
        async (ctx) => {
          const connector = await ownConnector(ctx),
            root = requiredText(
              ctx.url.searchParams.get('root') || ctx.body.root,
              'root',
            ),
            target = resolveRemotePath(root, text(ctx.body.path, '.'))
          const result = await hub.call(
            text(connector.id),
            method!,
            {
              ...ctx.body,
              sessionId: `browse_${connector.id}`,
              root,
              path: target,
            },
            { signal: ctx.signal, timeoutMs: 30_000 },
          )
          return route === 'readText'
            ? { ...record(result), serverTime: utcNow() }
            : { ok: true, result, error: null }
        },
        { permission: route === 'write' ? 'files.write' : 'files.read' },
      )
    router.add(
      'POST',
      '/connectors/{connector_id}/fs/read',
      async (ctx) => {
        const connector = await ownConnector(ctx),
          root = requiredText(
            ctx.url.searchParams.get('root') || ctx.body.root,
            'root',
          )
        return this.prepareTransfer(
          ctx,
          text(connector.id),
          root,
          resolveRemotePath(root, requiredText(ctx.body.path, 'path')),
        )
      },
      { permission: 'files.read' },
    )
    router.add(
      'POST',
      '/connectors/{connector_id}/fs/preview-token',
      async (ctx) => {
        const connector = await ownConnector(ctx),
          root = requiredText(
            ctx.url.searchParams.get('root') || ctx.body.root,
            'root',
          ),
          target = resolveRemotePath(root, requiredText(ctx.body.path, 'path'))
        const issued = this.issue({
          token: bearer(ctx.request),
          userId: ctx.account!.userId,
          connectorId: text(connector.id),
          root,
          path: target,
        })
        return {
          previewToken: issued.token,
          expiresAt: issued.expiresAt,
          serverTime: utcNow(),
        }
      },
      { permission: 'files.read' },
    )
    router.add(
      'POST',
      '/connectors/fs/preview-session',
      async (ctx) => {
        const access = await this.access(
          requiredText(ctx.body.previewToken, 'previewToken'),
          'files.read',
          true,
        )
        const issued = this.issue({ ...access, token: access.token }, 900000)
        return {
          previewAccessToken: issued.token,
          expiresAt: issued.expiresAt,
          connectorId: access.connectorId,
          root: access.root,
          path: access.path,
          serverTime: utcNow(),
        }
      },
      { public: true },
    )
    for (const mode of ['read', 'readText'])
      router.add(
        'POST',
        `/connectors/fs/preview/${mode}`,
        async (ctx) => {
          const access = await this.access(
            requiredText(ctx.body.previewAccessToken, 'previewAccessToken'),
            'files.read',
          )
          if (mode === 'read')
            return this.prepareTransfer(
              ctx,
              access.connectorId!,
              access.root!,
              access.path!,
              access,
            )
          const result = await hub.call(
            access.connectorId!,
            'fs.readText',
            {
              sessionId: `browse_${access.connectorId}`,
              root: access.root,
              path: access.path,
              maxBytes: integer(ctx.body.maxBytes, 1_048_576, 1, 4_194_304),
            },
            { signal: ctx.signal },
          )
          return { ...record(result), serverTime: utcNow() }
        },
        { public: true },
      )
    router.add(
      'PUT',
      '/connector/fs/transfers/{transfer_id}',
      async (ctx) => {
        const identity = await hub.authenticateConnector(bearer(ctx.request)),
          transfer = this.transfers.get(ctx.params.transfer_id!)
        if (
          !transfer ||
          transfer.connectorId !== identity.id ||
          transfer.expires < Date.now() ||
          ctx.url.searchParams.get('token') !== transfer.token
        )
          throw new ApiError(404, 'transfer not found')
        if (transfer.stream || transfer.data)
          throw new ApiError(409, 'transfer upload already started')
        const stream = new PassThrough({ highWaterMark: 64 * 1024 })
        stream.on('error', () => undefined)
        transfer.stream = stream
        transfer.resolve()
        const hash = createHash('sha256')
        let size = 0
        let validatedAt = 0
        const validate = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            size += chunk.length
            if (
              transfer.metadata.size != null &&
              size > Number(transfer.metadata.size)
            ) {
              done(new ApiError(422, 'file transfer size mismatch'))
              return
            }
            hash.update(chunk)
            if (Date.now() - validatedAt < 1000) {
              done(null, chunk)
              return
            }
            validatedAt = Date.now()
            void (async () => {
              await hub.authenticateConnector(bearer(ctx.request))
              const account = await hub.options.authenticateToken(
                transfer.accessToken,
              )
              requirePermission(account, 'files.read')
            })().then(
              () => done(null, chunk),
              (error) => done(error as Error),
            )
          },
          flush: (done) => {
            const digest = hash.digest('hex')
            if (
              (transfer.metadata.size != null &&
                size !== Number(transfer.metadata.size)) ||
              (transfer.metadata.sha256 && transfer.metadata.sha256 !== digest)
            ) {
              done(new ApiError(422, 'file transfer integrity mismatch'))
              return
            }
            done()
          },
        })
        await pipeline(ctx.request, validate, stream, { signal: ctx.signal })
        return { status: 'accepted' }
      },
      { public: true, rawBody: true },
    )
    router.add(
      'GET',
      '/connectors/{connector_id}/fs/transfers/{transfer_id}',
      async (ctx) => {
        const transfer = this.transfers.get(ctx.params.transfer_id!)
        if (
          !transfer ||
          transfer.expires < Date.now() ||
          transfer.connectorId !== ctx.params.connector_id ||
          transfer.token !== ctx.url.searchParams.get('token')
        )
          throw new ApiError(404, 'transfer not found')
        const account = await hub.options.authenticateToken(
          transfer.accessToken,
        )
        requirePermission(account, 'files.read')
        await store.connector(transfer.connectorId, account.userId)
        await hub.connectorAllowed(transfer.connectorId)
        if (transfer.openStream && !transfer.stream) {
          const stream = new PassThrough({ highWaterMark: 64 * 1024 })
          stream.on('error', () => undefined)
          transfer.stream = stream
          transfer.resolve()
          let validatedAt = 0
          let size = 0
          const hash = createHash('sha256')
          const validate = new Transform({
            transform: (chunk: Buffer, _encoding, done) => {
              size += chunk.length
              hash.update(chunk)
              if (Date.now() - validatedAt < 1000) {
                done(null, chunk)
                return
              }
              validatedAt = Date.now()
              void (async () => {
                const user = await hub.options.authenticateToken(
                  transfer.accessToken,
                )
                requirePermission(user, 'files.read')
                await hub.connectorAllowed(transfer.connectorId)
              })().then(
                () => done(null, chunk),
                (error) => done(error as Error),
              )
            },
            flush: (done) => {
              if (
                size !== transfer.metadata.size ||
                hash.digest('hex') !== transfer.metadata.sha256
              )
                done(new ApiError(409, 'file changed during download'))
              else done()
            },
          })
          void pipeline(transfer.openStream(), validate, stream, {
            signal: ctx.signal,
          }).catch((error) => stream.destroy(error as Error))
        }
        if (!transfer.data && !transfer.stream)
          await hub.call(
            transfer.connectorId,
            'fs.uploadPreparedDownload',
            {
              sessionId: transfer.sessionId,
              transferId: ctx.params.transfer_id,
              token: transfer.token,
              uploadUrl: `/api/v2/connector/fs/transfers/${ctx.params.transfer_id}`,
              root: transfer.metadata.root,
              path: transfer.metadata.path,
            },
            { signal: ctx.signal, timeoutMs: 10000 },
          )
        let waitTimer: NodeJS.Timeout | undefined
        await Promise.race([
          transfer.ready,
          new Promise((_, reject) => {
            waitTimer = setTimeout(
              () => reject(new ApiError(504, 'file transfer timed out')),
              30000,
            )
            waitTimer.unref()
          }),
        ]).finally(() => clearTimeout(waitTimer))
        if (transfer.data)
          this.send(ctx.response, transfer.data, transfer.metadata)
        else if (transfer.stream) {
          this.fileHeaders(ctx.response, transfer.metadata)
          if (
            Number.isSafeInteger(Number(transfer.metadata.size)) &&
            Number(transfer.metadata.size) >= 0
          )
            ctx.response.setHeader(
              'content-length',
              Number(transfer.metadata.size),
            )
          try {
            await pipeline(transfer.stream, ctx.response, {
              signal: ctx.signal,
            })
          } finally {
            this.transfers.delete(ctx.params.transfer_id!)
          }
        } else throw new ApiError(502, 'file transfer failed')
      },
      { public: true },
    )
    this.registerTerminals(router)
  }
  private async prepareTransfer(
    ctx: ApiContext,
    connectorId: string,
    root: string,
    target: string,
    access?: Access,
  ): Promise<Row> {
    for (const [id, transfer] of this.transfers)
      if (transfer.expires < Date.now()) {
        transfer.stream?.destroy(new ApiError(410, 'transfer expired'))
        this.transfers.delete(id)
      }
    const id = identifier('transfer'),
      token = identifier('download')
    let resolve!: () => void
    const ready = new Promise<void>((done) => {
      resolve = done
    })
    const transfer: Transfer = {
      connectorId,
      userId: access?.userId || ctx.account!.userId,
      sessionId: `browse_${connectorId}`,
      token,
      accessToken: access?.token || bearer(ctx.request),
      expires: Date.now() + 300000,
      metadata: {},
      resolve,
      ready,
    }
    this.transfers.set(id, transfer)
    try {
      const local = !this.hub.connections.get(connectorId)?.ws
      const result = record(
        await this.hub.call(
          connectorId,
          local ? 'fs.openRead' : 'fs.prepareDownload',
          { sessionId: transfer.sessionId, root, path: target },
          { signal: ctx.signal },
        ),
      )
      transfer.metadata = { ...result, root, path: result.path || target }
      if (typeof result.openStream === 'function') {
        transfer.openStream = result.openStream as () => Readable
      }
      if (typeof result.contentBase64 === 'string') {
        transfer.data = Buffer.from(result.contentBase64, 'base64')
        resolve()
      }
      return {
        ok: true,
        result: {
          ...result,
          contentBase64: undefined,
          openStream: undefined,
          transferId: id,
          token,
          downloadUrl: `/api/v2/connectors/${connectorId}/fs/transfers/${id}?token=${token}`,
        },
        error: null,
      }
    } catch (error) {
      this.transfers.delete(id)
      throw error
    }
  }
  private registerTerminals(router: ApiRouter): void {
    const hub = this.hub,
      store = hub.store,
      db = store.db
    for (const scope of ['connectors', 'sessions'])
      for (const v2 of scope === 'connectors' ? [false, true] : [false]) {
        const base = `/${scope}/{target_id}/terminals${v2 ? '-v2' : ''}`
        const target = async (ctx: ApiContext) => {
          if (scope === 'sessions') {
            const row = await store.session(
              ctx.params.target_id!,
              ctx.account!.userId,
            )
            await hub.connectorAllowed(text(row.connector_id))
            return {
              connectorId: text(row.connector_id),
              sessionId: text(row.id),
              root: text(row.cwd),
            }
          }
          const row = await store.connector(
            ctx.params.target_id!,
            ctx.account!.userId,
          )
          await hub.connectorAllowed(text(row.id))
          return {
            connectorId: text(row.id),
            sessionId: `browse_${row.id}`,
            root: text(ctx.url.searchParams.get('root') || ctx.body.root),
          }
        }
        router.add(
          'GET',
          base,
          async (ctx) => {
            const t = await target(ctx),
              result = record(
                await hub.call(
                  t.connectorId,
                  'terminal.list',
                  { sessionId: t.sessionId },
                  { signal: ctx.signal },
                ),
              )
            return v2
              ? { ok: true, result, error: null }
              : { terminals: result.terminals || [], serverTime: utcNow() }
          },
          { permission: 'terminal.use' },
        )
        router.add(
          'POST',
          base,
          async (ctx) => {
            const t = await target(ctx),
              root = requiredText(t.root, 'root'),
              cwd = resolveRemotePath(root, text(ctx.body.cwd, '.')),
              id = identifier('trm')
            const result = record(
              await hub.call(
                t.connectorId,
                'terminal.create',
                {
                  ...ctx.body,
                  sessionId: t.sessionId,
                  terminalId: id,
                  root,
                  cwd,
                  cols: integer(ctx.body.cols, 80, 1, 500),
                  rows: integer(ctx.body.rows, 24, 1, 200),
                  outputTransport: 'relay',
                },
                { signal: ctx.signal },
              ),
            )
            await db.query(
              'INSERT INTO connector_terminal_roots(connector_id,terminal_id,session_id,root,cwd,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
              [t.connectorId, id, t.sessionId, root, cwd, utcNow()],
            )
            return v2
              ? { ok: true, result, error: null }
              : { terminal: result.terminal || result, serverTime: utcNow() }
          },
          { permission: 'terminal.use' },
        )
        const operations = [
          ['PATCH', '', 'terminal.rename'],
          ['DELETE', '', 'terminal.close'],
          ['POST', '/resize', 'terminal.resize'],
          ...(v2
            ? [
                ['PATCH', '/persistence', 'terminal.setPersistent'],
                ['POST', '/write', 'terminal.write'],
                ['GET', '/snapshot', 'terminal.snapshot'],
              ]
            : []),
        ]
        for (const [verb, suffix, method] of operations)
          router.add(
            verb!,
            `${base}/{terminal_id}${suffix}`,
            async (ctx) => {
              const t = await target(ctx)
              const [binding] = await db.query(
                'SELECT * FROM connector_terminal_roots WHERE connector_id=$1 AND terminal_id=$2 AND session_id=$3',
                [t.connectorId, ctx.params.terminal_id, t.sessionId],
              )
              if (!binding) throw new ApiError(404, 'terminal not found')
              const params = {
                ...ctx.body,
                terminalId: ctx.params.terminal_id,
                sessionId: t.sessionId,
                root: binding.root,
                cwd: binding.cwd,
                fromSeq: integer(ctx.url.searchParams.get('fromSeq'), 0),
              }
              const result = await this.terminalCall(
                t.connectorId,
                ctx.params.terminal_id!,
                method!,
                params,
                ctx.signal,
              )
              if (method === 'terminal.close')
                await db.query(
                  'DELETE FROM connector_terminal_roots WHERE connector_id=$1 AND terminal_id=$2',
                  [t.connectorId, ctx.params.terminal_id],
                )
              return v2
                ? { ok: true, result, error: null }
                : {
                    terminal: record(result).terminal || result,
                    serverTime: utcNow(),
                  }
            },
            { permission: 'terminal.use' },
          )
      }
    router.add(
      'POST',
      '/connectors/{connector_id}/shell/exec',
      async (ctx) => {
        const connector = await store.connector(
            ctx.params.connector_id!,
            ctx.account!.userId,
          ),
          root = requiredText(
            ctx.url.searchParams.get('root') || ctx.body.root || ctx.body.cwd,
            'root',
          )
        return {
          ok: true,
          result: await hub.call(
            text(connector.id),
            'shell.exec',
            {
              ...ctx.body,
              root,
              cwd: resolveRemotePath(root, text(ctx.body.cwd, '.')),
              sessionId: `browse_${connector.id}`,
            },
            {
              signal: ctx.signal,
              timeoutMs: integer(ctx.body.timeoutMs, 30000, 1, 300000) + 5000,
            },
          ),
          error: null,
        }
      },
      { permission: 'terminal.use' },
    )
    const tasks = new Map<string, Row>()
    router.add(
      'POST',
      '/connectors/{connector_id}/shell/tasks',
      async (ctx) => {
        const connector = await store.connector(
            ctx.params.connector_id!,
            ctx.account!.userId,
          ),
          root = requiredText(
            ctx.url.searchParams.get('root') || ctx.body.root || ctx.body.cwd,
            'root',
          ),
          taskId = identifier('task')
        const task: Row = {
          taskId,
          connectorId: connector.id,
          sessionId: `browse_${connector.id}`,
          command: ctx.body.command,
          cwd: resolveRemotePath(root, text(ctx.body.cwd, '.')),
          timeoutMs: integer(ctx.body.timeoutMs, 30000, 1, 300000),
          status: 'running',
          result: null,
          error: null,
        }
        tasks.set(taskId, task)
        void hub
          .call(
            text(connector.id),
            'shell.exec',
            { ...task, root },
            { timeoutMs: Number(task.timeoutMs) + 5000 },
          )
          .then(
            (result) => {
              task.status = 'completed'
              task.result = result
            },
            () => {
              task.status = 'failed'
              task.error = {
                code: 'execution_failed',
                message: 'shell command failed',
              }
            },
          )
        return { ...task, serverTime: utcNow() }
      },
      { permission: 'terminal.use' },
    )
    router.add(
      'GET',
      '/connectors/{connector_id}/shell/tasks/{task_id}/wait',
      async (ctx) => {
        await store.connector(ctx.params.connector_id!, ctx.account!.userId)
        const task = tasks.get(ctx.params.task_id!)
        if (!task || task.connectorId !== ctx.params.connector_id)
          throw new ApiError(404, 'task not found')
        const deadline =
          Date.now() +
          integer(ctx.url.searchParams.get('timeoutMs'), 120000, 1, 300000)
        while (
          task.status === 'running' &&
          Date.now() < deadline &&
          !ctx.signal.aborted
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          await ctx.user('terminal.use')
          await this.hub.connectorAllowed(ctx.params.connector_id!)
        }
        return { ...task, serverTime: utcNow() }
      },
      { permission: 'terminal.use' },
    )
  }
  private async terminalCall(
    connectorId: string,
    terminalId: string,
    method: string,
    params: Row,
    signal?: AbortSignal,
  ): Promise<Row> {
    if (
      ![
        'terminal.write',
        'terminal.resize',
        'terminal.snapshot',
        'terminal.close',
      ].includes(method)
    )
      return record(
        await this.hub.call(connectorId, method, params, { signal }),
      )
    const key = `${connectorId}:${terminalId}`
    let relay = this.relays.get(key)
    if (!relay && this.hub.connections.get(connectorId)?.ws) {
      const access: RelayAccess = {
        token: identifier('relay'),
        connectorId,
        terminalId,
        sessionId: text(params.sessionId),
        root: text(params.root),
        cwd: text(params.cwd),
        expires: Date.now() + 60000,
      }
      this.relayAccess.set(terminalId, access)
      const waiting = new Promise<Relay>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.hub.events.off(`relay-ready:${key}`, ready)
          reject(new ApiError(504, 'terminal relay did not connect'))
        }, 10000)
        timer.unref()
        const ready = (value: Relay) => {
          clearTimeout(timer)
          resolve(value)
        }
        this.hub.events.once(`relay-ready:${key}`, ready)
      })
      await this.hub.call(
        connectorId,
        'terminal.relay.connect',
        {
          terminalId,
          sessionId: access.sessionId,
          token: access.token,
          mode: 'attach',
        },
        { signal },
      )
      relay = await waiting
    }
    if (!relay)
      return record(
        await this.hub.call(connectorId, method, params, { signal }),
      )
    const activeRelay = relay
    const requestId = identifier('relay')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        activeRelay.pending.delete(requestId)
        reject(new ApiError(504, 'terminal relay timed out'))
      }, 15000)
      timer.unref()
      activeRelay.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      activeRelay.socket.send(
        JSON.stringify({
          ...params,
          type: method === 'terminal.write' ? 'input' : method.split('.')[1],
          requestId,
          data: params.dataBase64 || params.data,
        }),
      )
    })
  }
  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = new URL(request.url || '/', 'http://localhost')
    const relayPath = /^\/api\/v2\/connector\/terminals\/([^/]+)\/relay$/.exec(
      url.pathname,
    )
    const targetPath =
      /^\/api\/v2\/(connectors|sessions)\/([^/]+)\/terminals(?:-v2)?\/([^/]+)\/stream$/.exec(
        url.pathname,
      )
    if (!relayPath && !targetPath) return false
    try {
      if (relayPath) {
        const terminalId = decodeURIComponent(relayPath[1]!),
          access = this.relayAccess.get(terminalId)
        if (
          !access ||
          access.expires < Date.now() ||
          access.token !== url.searchParams.get('token')
        )
          throw new ApiError(401, 'invalid terminal relay token')
        await this.hub.connectorAllowed(access.connectorId)
        const identity = { id: access.connectorId }
        this.hub.server.handleUpgrade(request, socket, head, (ws) => {
          const key = `${identity.id}:${terminalId}`,
            relay: Relay = {
              connectorId: identity.id,
              terminalId,
              socket: ws,
              pending: new Map(),
            }
          this.relays.get(key)?.socket.close(1008, 'relay replaced')
          this.relays.set(key, relay)
          ws.send(
            JSON.stringify({
              type: 'start',
              mode: 'attach',
              terminalId,
              sessionId: access.sessionId,
              root: access.root,
              cwd: access.cwd,
              cols: 80,
              rows: 24,
              env: {},
              persistent: false,
            }),
          )
          this.hub.events.emit(`relay-ready:${key}`, relay)
          ws.on('message', (data) => {
            let message: Row
            try {
              message = object(JSON.parse(data.toString()))
            } catch {
              ws.close(1003)
              return
            }
            if (message.requestId) {
              const pending = relay.pending.get(text(message.requestId))
              relay.pending.delete(text(message.requestId))
              if (
                message.type === 'error' ||
                message.ok === false ||
                message.error
              )
                pending?.reject(
                  new ApiError(502, text(message.message, 'terminal error')),
                )
              else pending?.resolve(record(message.result || message))
            }
            this.hub.events.emit(`terminal:${key}`, message)
          })
          ws.on('close', () => {
            if (this.relays.get(key) === relay) this.relays.delete(key)
            for (const p of relay.pending.values())
              p.reject(new ApiError(409, 'terminal relay closed'))
          })
        })
      } else {
        const token = bearer(request) || url.searchParams.get('token') || '',
          account = await this.hub.options.authenticateToken(token)
        requirePermission(account, 'terminal.use')
        const targetId = decodeURIComponent(targetPath![2]!),
          terminalId = decodeURIComponent(targetPath![3]!)
        const target =
          targetPath![1] === 'sessions'
            ? await this.hub.store.session(targetId, account.userId)
            : await this.hub.store.connector(targetId, account.userId)
        const connectorId = text(target.connector_id || target.id),
          sessionId =
            targetPath![1] === 'sessions' ? targetId : `browse_${connectorId}`
        const [binding] = await this.hub.store.db.query(
          'SELECT * FROM connector_terminal_roots WHERE connector_id=$1 AND terminal_id=$2 AND session_id=$3',
          [connectorId, terminalId, sessionId],
        )
        if (!binding) throw new ApiError(404, 'terminal not found')
        await this.hub.connectorAllowed(connectorId)
        this.hub.server.handleUpgrade(request, socket, head, (ws) => {
          const client = {
            ws,
            userId: account.userId,
            token,
            permission: 'terminal.use',
            connectorId,
          }
          this.hub.clients.add(client)
          const key = `${connectorId}:${terminalId}`,
            params = {
              terminalId,
              sessionId,
              root: binding.root,
              cwd: binding.cwd,
            }
          let lane = Promise.resolve()
          const send = (message: Row) => {
            lane = lane
              .then(async () => {
                const current = await this.hub.options.authenticateToken(token)
                requirePermission(current, 'terminal.use')
                await this.hub.connectorAllowed(connectorId)
                if (ws.readyState === WebSocket.OPEN)
                  ws.send(JSON.stringify(message))
              })
              .catch(() => ws.close(1008, 'authorization changed'))
          }
          const live = ({
            method,
            params: event,
          }: {
            method: string
            params: Row
          }) => {
            if (event.terminalId !== terminalId) return
            send(
              method === 'terminal.output'
                ? { type: 'output', data: event.dataBase64, seq: event.seq }
                : { type: 'exit', exitCode: event.exitCode },
            )
          }
          this.hub.events.on(`terminal:${key}`, send)
          this.hub.events.on(`realtime:${connectorId}`, live)
          void this.terminalCall(connectorId, terminalId, 'terminal.snapshot', {
            ...params,
            fromSeq: integer(url.searchParams.get('fromSeq'), 0),
          }).then(
            (result) =>
              send({
                type: 'replay',
                data: result.dataBase64 || '',
                seq: result.seq || 0,
              }),
            () =>
              send({
                type: 'error',
                code: 409,
                message: 'terminal unavailable',
              }),
          )
          ws.on('message', (data) => {
            lane = lane
              .then(async () => {
                const current = await this.hub.options.authenticateToken(token)
                requirePermission(current, 'terminal.use')
                await this.hub.connectorAllowed(connectorId)
                const message = object(JSON.parse(data.toString())),
                  type = text(message.type)
                if (type === 'ping') {
                  send({ type: 'pong' })
                  return
                }
                if (!['input', 'resize'].includes(type))
                  throw new ApiError(422, 'unsupported terminal message')
                await this.terminalCall(
                  connectorId,
                  terminalId,
                  type === 'input' ? 'terminal.write' : 'terminal.resize',
                  {
                    ...params,
                    dataBase64: message.data,
                    cols: integer(message.cols, 80, 1, 500),
                    rows: integer(message.rows, 24, 1, 200),
                  },
                )
              })
              .catch(() => ws.close(1008, 'terminal request rejected'))
          })
          ws.on('close', () => {
            this.hub.clients.delete(client)
            this.hub.events.off(`terminal:${key}`, send)
            this.hub.events.off(`realtime:${connectorId}`, live)
          })
        })
      }
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error instanceof ApiError ? error.status : 500} Rejected\r\nConnection: close\r\n\r\n`,
      )
    }
    return true
  }
  close(): void {
    for (const relay of this.relays.values())
      relay.socket.close(1001, 'server shutdown')
    this.relays.clear()
    this.accesses.clear()
    for (const transfer of this.transfers.values())
      transfer.stream?.destroy(new ApiError(503, 'server stopped'))
    this.transfers.clear()
    this.storage.close()
  }
}
