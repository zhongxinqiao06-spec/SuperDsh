/** 存储连接只返回凭据是否已配置；编辑草稿从不回填秘密。 */
export interface StorageConnection {
  id: string
  name: string
  backend: 'local' | 's3'
  configuration: {
    backend: 'local' | 's3'
    endpoint?: string
    bucket?: string
    region?: string
    prefix?: string
    virtualHostStyle?: boolean
  }
  credentialConfigured: boolean
  revision: number
  enabled: boolean
}
export interface StoragePolicy {
  maxFileBytes: number
  temporaryHours: number
  recycleDays: number
}
export interface StorageSettings {
  activeConnectionId: string
  revision: number
  policy: StoragePolicy
  connections: StorageConnection[]
}
export interface ConnectionDraft {
  name: string
  endpoint: string
  bucket: string
  region: string
  prefix: string
  virtualHostStyle: boolean
  enabled: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}
export interface ConnectionInput {
  name: string
  enabled: boolean
  revision?: number
  configuration: {
    backend: 's3'
    endpoint: string
    bucket: string
    region: string
    prefix: string
    virtualHostStyle: boolean
  }
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}
export interface StorageUsage {
  items: { storage_id: string; objects: string; bytes: string }[]
  files: number
  bytes: number
}
export interface StorageMigration {
  id: string
  fileId: string
  sourceId: string
  targetId: string
  state: string
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface StorageMigrations {
  items: { state: string; total: string }[]
  records: StorageMigration[]
  /** 清理失败保留收据，平台恢复后可再次运行维护，不丢对象身份。 */
  cleanup?: {
    id: string
    fileId: string
    storageId: string
    state: string
    error: string | null
  }[]
}
