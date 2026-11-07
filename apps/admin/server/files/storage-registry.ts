import { createHash, randomUUID } from 'node:crypto'
import type { Database, Row } from '../infrastructure/database.ts'
import {
  ApiError,
  integer,
  object,
  requiredText,
  text,
  utcNow,
} from '../http/api-router.ts'
import { createModelCredentialCipher } from '../identity/model-credentials.ts'
import {
  createObjectStorage,
  environmentStorage,
  type ObjectStorage,
  type ObjectStorageConfiguration,
  type ObjectStorageCredentials,
} from './object-storage.ts'
import type { StoragePolicy } from '@superdsh/core/contracts/platform'

export const defaultStoragePolicy: StoragePolicy = {
  maxFileBytes: 32 * 1024 * 1024,
  temporaryHours: 24,
  recycleDays: 30,
}

export class StorageRegistry {
  readonly options: {
    db: Database
    root: string
    encryptionKey: string
    environment?: NodeJS.ProcessEnv
  }
  private readonly cipher: ReturnType<typeof createModelCredentialCipher>
  private readonly stores = new Map<string, ObjectStorage>()
  private initialized?: Promise<void>
  readonly environmentId: string
  constructor(options: StorageRegistry['options']) {
    this.options = options
    this.cipher = createModelCredentialCipher(options.encryptionKey)
    this.environmentId =
      'storage_env_' +
      createHash('sha256')
        .update(
          JSON.stringify(
            environmentStorage(options.root, options.environment).config,
          ),
        )
        .digest('hex')
        .slice(0, 24)
  }
  async initialize() {
    this.initialized ??= this.bootstrap().catch((error) => {
      this.initialized = undefined
      throw error
    })
    return this.initialized
  }
  private async bootstrap() {
    const { config, credentials } = environmentStorage(
      this.options.root,
      this.options.environment,
    )
    const now = utcNow()
    await this.options.db.transaction(async (db) => {
      await db.query(
        `INSERT INTO file_storage_connections(id,name,backend,configuration_json,credentials_ciphertext,created_at,updated_at)
        VALUES($1,'环境存储',$2,$3,$4,$5,$5) ON CONFLICT(id) DO NOTHING`,
        [
          this.environmentId,
          config.backend,
          JSON.stringify(config),
          credentials
            ? this.cipher.seal(JSON.stringify(credentials), this.environmentId)
            : null,
          now,
        ],
      )
      await db.query(
        `INSERT INTO file_storage_settings(id,active_connection_id,policy_json,updated_at)
        VALUES('global',$1,$2,$3) ON CONFLICT(id) DO NOTHING`,
        [this.environmentId, JSON.stringify(defaultStoragePolicy), now],
      )
    })
  }
  async settings() {
    await this.initialize()
    const [row] = await this.options.db.query(
      "SELECT * FROM file_storage_settings WHERE id='global'",
    )
    return {
      activeConnectionId: text(row!.active_connection_id),
      policy: JSON.parse(text(row!.policy_json)) as StoragePolicy,
      revision: Number(row!.revision),
    }
  }
  async list() {
    await this.initialize()
    const rows = await this.options.db.query(
      'SELECT * FROM file_storage_connections ORDER BY created_at,id',
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      backend: row.backend,
      configuration: JSON.parse(text(row.configuration_json)),
      credentialConfigured: Boolean(row.credentials_ciphertext),
      revision: Number(row.revision),
      enabled: Boolean(row.enabled),
    }))
  }
  async get(id: string, writing = false) {
    await this.initialize()
    const [row] = await this.options.db.query(
      'SELECT * FROM file_storage_connections WHERE id=$1',
      [id],
    )
    if (!row) throw new ApiError(503, '文件存储连接不存在')
    if (writing && !row.enabled) throw new ApiError(503, '文件存储连接已停用')
    const key = id + ':' + row.revision
    let storage = this.stores.get(key)
    if (!storage) {
      const config = JSON.parse(
        text(row.configuration_json),
      ) as ObjectStorageConfiguration
      const credentials = row.credentials_ciphertext
        ? (JSON.parse(
            this.cipher.open(text(row.credentials_ciphertext), id),
          ) as ObjectStorageCredentials)
        : undefined
      storage = createObjectStorage(config, credentials)
      this.stores.set(key, storage)
    }
    return storage
  }
  async save(id: string | undefined, body: Row) {
    await this.initialize()
    const name = requiredText(body.name, '存储名称', 100)
    const config = object(body.configuration)
    if (config.backend !== 's3')
      throw new ApiError(422, '管理界面只允许配置 S3 存储')
    const address = requiredText(config.endpoint, 'S3 地址')
    if (!URL.canParse(address)) throw new ApiError(422, 'S3 地址格式不正确')
    const endpoint = new URL(address)
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ApiError(422, 'S3 地址格式不正确')
    const configuration: ObjectStorageConfiguration = {
      backend: 's3',
      endpoint: endpoint.href.replace(/\/$/, ''),
      bucket: requiredText(config.bucket, 'Bucket', 63),
      region: text(config.region, 'us-east-1'),
      prefix: text(config.prefix),
      virtualHostStyle: config.virtualHostStyle === true,
    }
    const storageId = id || 'storage_' + randomUUID().replaceAll('-', '')
    await this.options.db.transaction(async (db) => {
      const [old] = await db.query(
        'SELECT * FROM file_storage_connections WHERE id=$1 FOR UPDATE',
        [storageId],
      )
      if (id && !old) throw new ApiError(404, '存储连接不存在')
      if (old && Number(body.revision) !== Number(old.revision))
        throw new ApiError(409, '存储配置已修改，请刷新后重试')
      if (
        old &&
        JSON.stringify(configuration) !==
          JSON.stringify(JSON.parse(text(old.configuration_json)))
      )
        throw new ApiError(409, '存储位置不可原位修改，请新增连接并迁移文件')
      const secret =
        body.credentials == null ? undefined : object(body.credentials)
      const encrypted = secret
        ? this.cipher.seal(
            JSON.stringify({
              accessKeyId: requiredText(secret.accessKeyId, 'Access Key'),
              secretAccessKey: requiredText(
                secret.secretAccessKey,
                'Secret Key',
              ),
            }),
            storageId,
          )
        : old?.credentials_ciphertext
      if (!encrypted) throw new ApiError(422, '请配置存储凭据')
      await db.query(
        `INSERT INTO file_storage_connections(id,name,backend,configuration_json,credentials_ciphertext,enabled,created_at,updated_at)
        VALUES($1,$2,'s3',$3,$4,$5,$6,$6) ON CONFLICT(id) DO UPDATE SET name=$2,credentials_ciphertext=$4,enabled=$5,revision=file_storage_connections.revision+1,updated_at=$6`,
        [
          storageId,
          name,
          JSON.stringify(configuration),
          encrypted,
          body.enabled === false ? 0 : 1,
          utcNow(),
        ],
      )
    })
    return (await this.list()).find((row) => row.id === storageId)!
  }
  async update(body: Row) {
    const settings = await this.settings()
    const id = requiredText(body.activeConnectionId, '存储连接')
    const policy = object(body.policy)
    const next: StoragePolicy = {
      maxFileBytes: integer(
        policy.maxFileBytes,
        settings.policy.maxFileBytes,
        1,
        10 * 1024 ** 3,
      ),
      temporaryHours: integer(policy.temporaryHours, 24, 1, 168),
      recycleDays: integer(policy.recycleDays, 30, 1, 365),
    }
    await (await this.get(id, true)).check()
    const rows = await this.options.db.query(
      "UPDATE file_storage_settings SET active_connection_id=$1,policy_json=$2,revision=revision+1,updated_at=$3 WHERE id='global' AND revision=$4 RETURNING id",
      [id, JSON.stringify(next), utcNow(), integer(body.revision, 0)],
    )
    if (!rows.length) throw new ApiError(409, '存储设置已修改，请刷新后重试')
    return this.settings()
  }
  close() {
    for (const store of this.stores.values()) store.close()
    this.stores.clear()
  }
}
