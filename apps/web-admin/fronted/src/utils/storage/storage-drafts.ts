import type {
  ConnectionDraft,
  ConnectionInput,
  StorageConnection,
} from '@/types/storage/storage'

/** 生成独立编辑草稿，服务端掩码不会作为新密钥提交。 */
export function connectionDraft(
  connection?: StorageConnection,
): ConnectionDraft {
  return {
    name: connection?.name ?? '',
    endpoint: connection?.configuration.endpoint ?? '',
    bucket: connection?.configuration.bucket ?? '',
    region: connection?.configuration.region ?? 'us-east-1',
    prefix: connection?.configuration.prefix ?? '',
    virtualHostStyle: connection?.configuration.virtualHostStyle ?? false,
    enabled: connection?.enabled ?? true,
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
  }
}

/** 凭据两项须一起填写；空白表示保留已有凭据，不能意外清空。 */
export function connectionInput(
  draft: ConnectionDraft,
  revision?: number,
): ConnectionInput {
  if (
    Boolean(draft.accessKeyId.trim()) !== Boolean(draft.secretAccessKey.trim())
  )
    throw new Error('访问密钥与秘密密钥需要一起填写')
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    ...(revision !== undefined ? { revision } : {}),
    configuration: {
      backend: 's3',
      endpoint: draft.endpoint.trim(),
      bucket: draft.bucket.trim(),
      region: draft.region.trim(),
      prefix: draft.prefix.trim(),
      virtualHostStyle: draft.virtualHostStyle,
    },
    ...(draft.accessKeyId.trim()
      ? {
          credentials: {
            accessKeyId: draft.accessKeyId.trim(),
            secretAccessKey: draft.secretAccessKey,
            ...(draft.sessionToken ? { sessionToken: draft.sessionToken } : {}),
          },
        }
      : {}),
  }
}
