import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Row } from '../infrastructure/database.ts'

export interface FileStorage {
  read(
    sessionId: string,
    fileId: string,
  ): Promise<{ data: Buffer; metadata: Row }>
  write(
    sessionId: string,
    fileId: string,
    data: Buffer,
    metadata: Row,
  ): Promise<void>
  close(): void
}
export function createFileStorage(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): FileStorage {
  const backend = environment.AGENT_SERVER_FILES_BACKEND || 'local'
  if (backend === 'local') {
    const directory = path.resolve(
      environment.AGENT_SERVER_FILES_LOCAL_ROOT || root,
    )
    return {
      async read(sessionId, fileId) {
        const location = path.join(directory, sessionId, fileId)
        return {
          data: await readFile(`${location}.bin`),
          metadata: JSON.parse(
            await readFile(`${location}.json`, 'utf8'),
          ) as Row,
        }
      },
      async write(sessionId, fileId, data, metadata) {
        const location = path.join(directory, sessionId, fileId),
          temporary = `${location}.${randomBytes(12).toString('hex')}.tmp`
        await mkdir(path.dirname(location), { recursive: true, mode: 0o700 })
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
        await rename(temporary, `${location}.bin`)
        await writeFile(`${location}.json`, JSON.stringify(metadata), {
          mode: 0o600,
        })
      },
      close() {},
    }
  }
  if (backend !== 's3')
    throw new Error(`Unknown file storage backend: ${backend}`)
  const required = (name: string) => {
    const value = environment[name]
    if (!value) throw new Error(`${name} is required for S3 file storage`)
    return value
  }
  const bucket = required('AGENT_SERVER_FILES_S3_BUCKET'),
    prefix = (environment.AGENT_SERVER_FILES_S3_PREFIX || '').replace(
      /^\/+|\/+$/g,
      '',
    )
  const client = new S3Client({
    region: environment.AGENT_SERVER_FILES_S3_REGION || 'us-east-1',
    endpoint: environment.AGENT_SERVER_FILES_S3_ENDPOINT_URL || undefined,
    forcePathStyle: !['1', 'true', 'yes', 'on'].includes(
      (
        environment.AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE || ''
      ).toLowerCase(),
    ),
    credentials: {
      accessKeyId: required('AGENT_SERVER_FILES_S3_ACCESS_KEY'),
      secretAccessKey: required('AGENT_SERVER_FILES_S3_SECRET_KEY'),
    },
  })
  const key = (sessionId: string, fileId: string, extension: string) =>
    `${prefix ? `${prefix}/` : ''}${sessionId}/${fileId}.${extension}`
  return {
    async read(sessionId, fileId) {
      const [blob, meta] = await Promise.all([
        client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key(sessionId, fileId, 'bin'),
          }),
        ),
        client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key(sessionId, fileId, 'json'),
          }),
        ),
      ])
      if (!blob.Body || !meta.Body) throw new Error('S3 file not found')
      return {
        data: Buffer.from(await blob.Body.transformToByteArray()),
        metadata: JSON.parse(await meta.Body.transformToString('utf8')) as Row,
      }
    },
    async write(sessionId, fileId, data, metadata) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(sessionId, fileId, 'bin'),
          Body: data,
          ContentType: String(metadata.mediaType || 'application/octet-stream'),
        }),
      )
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(sessionId, fileId, 'json'),
          Body: JSON.stringify(metadata),
          ContentType: 'application/json',
        }),
      )
    },
    close() {
      client.destroy()
    },
  }
}
