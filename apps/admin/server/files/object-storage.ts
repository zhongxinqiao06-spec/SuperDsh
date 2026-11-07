import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3'
import { ApiError } from '../http/api-router.ts'

export interface ObjectStorageConfiguration {
  backend: 'local' | 's3'
  root?: string
  endpoint?: string
  bucket?: string
  region?: string
  prefix?: string
  virtualHostStyle?: boolean
}
export interface ObjectStorageCredentials {
  accessKeyId: string
  secretAccessKey: string
}
export interface ObjectRange {
  start: number
  end: number
}
export interface ObjectStorage {
  read(
    key: string,
    range?: ObjectRange,
    signal?: AbortSignal,
  ): Promise<Readable>
  write(
    key: string,
    data: Readable,
    size: number,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<void>
  head(key: string): Promise<{ size: number }>
  list(
    prefix?: string,
  ): AsyncIterable<{ key: string; size: number; modifiedAt: string }>
  remove(key: string): Promise<void>
  check(): Promise<void>
  cleanIncomplete(before: string, apply: boolean): Promise<number>
  close(): void
}

export function safeObjectKey(key: string): string {
  if (
    !key ||
    key.length > 1000 ||
    !/^[a-zA-Z0-9_./-]+$/.test(key) ||
    key.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ApiError(422, 'invalid storage object key')
  return key
}

export function createObjectStorage(
  config: ObjectStorageConfiguration,
  credentials?: ObjectStorageCredentials,
): ObjectStorage {
  if (config.backend === 'local') {
    if (!config.root) throw new Error('Local storage root is required')
    const root = resolve(config.root)
    const location = (key: string) => {
      const target = resolve(root, safeObjectKey(key))
      if (!target.startsWith(root + sep))
        throw new ApiError(422, 'invalid storage path')
      return target
    }
    return {
      async read(key, range, signal) {
        const file = location(key)
        await stat(file)
        return createReadStream(file, { ...range, signal })
      },
      async write(key, data, size, _type, signal) {
        const target = location(key)
        const temporary = target + '.' + randomUUID() + '.tmp'
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        try {
          await pipeline(
            data,
            createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
            { signal },
          )
          if ((await stat(temporary)).size !== size)
            throw new ApiError(422, 'file size does not match content')
          await rename(temporary, target)
        } finally {
          await unlink(temporary).catch(() => {})
        }
      },
      async head(key) {
        return { size: (await stat(location(key))).size }
      },
      async *list(prefix = '') {
        async function* walk(
          directory: string,
          base = '',
        ): AsyncGenerator<{ key: string; size: number; modifiedAt: string }> {
          for (const item of await readdir(directory, {
            withFileTypes: true,
          }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return []
            throw error
          })) {
            const key = base + item.name
            if (item.isDirectory())
              yield* walk(resolve(directory, item.name), key + '/')
            else if (item.isFile() && key.startsWith(prefix)) {
              const info = await stat(location(key))
              yield {
                key,
                size: info.size,
                modifiedAt: info.mtime.toISOString(),
              }
            }
          }
        }
        yield* walk(root)
      },
      async remove(key) {
        await unlink(location(key)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      },
      async check() {
        await mkdir(root, { recursive: true, mode: 0o700 })
      },
      async cleanIncomplete() {
        return 0
      },
      close() {},
    }
  }
  if (
    !config.bucket ||
    !credentials?.accessKeyId ||
    !credentials.secretAccessKey
  )
    throw new Error('S3 bucket and credentials are required')
  const client = new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region || 'us-east-1',
    forcePathStyle: !config.virtualHostStyle,
    credentials,
    maxAttempts: 1,
  })
  const prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '')
  if (prefix) safeObjectKey(prefix)
  const input = (key: string) => ({
    Bucket: config.bucket!,
    Key: (prefix ? prefix + '/' : '') + safeObjectKey(key),
  })
  return {
    async read(key, range, signal) {
      const result = await client.send(
        new GetObjectCommand({
          ...input(key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        { abortSignal: signal },
      )
      if (!(result.Body instanceof Readable))
        throw new Error('Storage did not return a readable object')
      return result.Body
    },
    async write(key, data, size, mediaType, signal) {
      const partSize = 8 * 1024 * 1024
      if (size > partSize) {
        const created = await client.send(
          new CreateMultipartUploadCommand({
            ...input(key),
            ContentType: mediaType,
          }),
          { abortSignal: signal },
        )
        if (!created.UploadId) throw new ApiError(502, '存储未返回分片上传标识')
        const upload = { ...input(key), UploadId: created.UploadId }
        const parts: { ETag: string; PartNumber: number }[] = []
        const buffer = Buffer.alloc(partSize)
        let used = 0,
          received = 0
        const send = async () => {
          const partNumber = parts.length + 1
          const result = await client.send(
            new UploadPartCommand({
              ...upload,
              PartNumber: partNumber,
              Body: buffer.subarray(0, used),
              ContentLength: used,
            }),
            { abortSignal: signal },
          )
          if (!result.ETag) throw new ApiError(502, '存储未确认上传分片')
          parts.push({ PartNumber: partNumber, ETag: result.ETag })
          used = 0
        }
        try {
          for await (const chunk of data) {
            signal?.throwIfAborted()
            const bytes = Buffer.from(chunk)
            received += bytes.length
            if (received > size) throw new ApiError(422, '存储流大小超过声明值')
            let offset = 0
            while (offset < bytes.length) {
              const length = Math.min(partSize - used, bytes.length - offset)
              bytes.copy(buffer, used, offset, offset + length)
              used += length
              offset += length
              if (used === partSize) await send()
            }
          }
          if (received !== size)
            throw new ApiError(422, '存储流大小与声明值不一致')
          if (used) await send()
          await client.send(
            new CompleteMultipartUploadCommand({
              ...upload,
              MultipartUpload: { Parts: parts },
            }),
            { abortSignal: signal },
          )
        } catch (error) {
          data.destroy()
          await client
            .send(new AbortMultipartUploadCommand(upload), {
              abortSignal: AbortSignal.timeout(10000),
            })
            .catch(() => {})
          throw error
        }
        return
      }
      await client.send(
        new PutObjectCommand({
          ...input(key),
          Body: data,
          ContentLength: size,
          ContentType: mediaType,
        }),
        { abortSignal: signal },
      )
    },
    async head(key) {
      const result = await client.send(new HeadObjectCommand(input(key)))
      return { size: result.ContentLength ?? 0 }
    },
    async *list(filter = '') {
      let cursor: string | undefined
      const base = prefix ? prefix + '/' : ''
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: base + filter,
            ContinuationToken: cursor,
            MaxKeys: 100,
          }),
        )
        for (const item of page.Contents ?? [])
          if (item.Key && item.LastModified)
            yield {
              key: item.Key.slice(base.length),
              size: item.Size || 0,
              modifiedAt: item.LastModified.toISOString(),
            }
        cursor = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (cursor)
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand(input(key)))
    },
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
    },
    async cleanIncomplete(before, apply) {
      let keyMarker: string | undefined,
        uploadMarker: string | undefined,
        count = 0
      do {
        const page = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: config.bucket,
            Prefix: (prefix ? prefix + '/' : '') + 'objects/',
            KeyMarker: keyMarker,
            UploadIdMarker: uploadMarker,
            MaxUploads: 100,
          }),
        )
        for (const item of page.Uploads ?? [])
          if (
            item.Key &&
            item.UploadId &&
            item.Initiated &&
            item.Initiated.toISOString() < before
          ) {
            count++
            if (apply)
              await client.send(
                new AbortMultipartUploadCommand({
                  Bucket: config.bucket,
                  Key: item.Key,
                  UploadId: item.UploadId,
                }),
              )
          }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined
        uploadMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined
      } while (keyMarker)
      return count
    },
    close() {
      client.destroy()
    },
  }
}

export function environmentStorage(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const backend = env.AGENT_SERVER_FILES_BACKEND || 'local'
  if (backend !== 'local' && backend !== 's3')
    throw new Error('Unknown file storage backend: ' + backend)
  return {
    config: {
      backend,
      root:
        backend === 'local'
          ? resolve(env.AGENT_SERVER_FILES_LOCAL_ROOT || root)
          : undefined,
      endpoint: env.AGENT_SERVER_FILES_S3_ENDPOINT_URL,
      bucket: env.AGENT_SERVER_FILES_S3_BUCKET,
      region: env.AGENT_SERVER_FILES_S3_REGION || 'us-east-1',
      prefix: env.AGENT_SERVER_FILES_S3_PREFIX,
      virtualHostStyle: /^(1|true|yes|on)$/i.test(
        env.AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE || '',
      ),
    } satisfies ObjectStorageConfiguration,
    credentials:
      backend === 's3'
        ? {
            accessKeyId: env.AGENT_SERVER_FILES_S3_ACCESS_KEY || '',
            secretAccessKey: env.AGENT_SERVER_FILES_S3_SECRET_KEY || '',
          }
        : undefined,
  }
}

export function parseRange(
  header: string | undefined,
  size: number,
): ObjectRange | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0)
    throw new ApiError(416, 'requested range is not satisfiable')
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]))
  const end = match[1]
    ? match[2]
      ? Math.min(size - 1, Number(match[2]))
      : size - 1
    : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new ApiError(416, 'requested range is not satisfiable')
  return { start, end }
}
