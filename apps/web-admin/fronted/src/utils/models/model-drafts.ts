import type {
  ConfigurationDraft,
  ConnectionDraft,
  ModelConnection,
  ModelConfiguration,
  ModelProvider,
  ProviderDraft,
} from '@/types/models/models'

/** 从公开响应重建请求字段，避免把脱敏状态或旧密钥回传服务端。 */
export function providerDraft(value?: ModelProvider): ProviderDraft {
  return {
    name: value?.name ?? '',
    protocol: value?.protocol ?? 'openai-completions',
    baseUrl: value?.baseUrl ?? '',
    enabled: value?.enabled ?? true,
    apiKey: '',
    clearApiKey: false,
    models: value
      ? structuredClone(value.models)
      : [
          {
            modelId: '',
            name: '',
            contextWindow: null,
            maxTokens: null,
            inputTypes: ['text'],
          },
        ],
  }
}
/** 编辑连接不显示或复制已有密钥。 */
export function connectionDraft(value?: ModelConnection): ConnectionDraft {
  return {
    name: value?.name ?? '',
    adapter: value?.adapter ?? 'openai-completions',
    baseUrl: value?.baseUrl ?? '',
    region: value?.region ?? '',
    enabled: value?.enabled ?? true,
    ...(value ? { revision: value.revision } : {}),
    apiKey: '',
    clearApiKey: false,
  }
}
/** 深拷贝参数和角色集合，取消编辑不会改变列表。 */
export function configurationDraft(
  value?: ModelConfiguration,
  multimodal = false,
): ConfigurationDraft {
  return {
    name: value?.name ?? '',
    connectionId: value?.connectionId ?? '',
    capability: value?.capability ?? (multimodal ? 'image.generate' : 'chat'),
    modelId: value?.modelId ?? '',
    enabled: value?.enabled ?? true,
    parameters: structuredClone(value?.parameters ?? {}),
    roleIds: [...(value?.roleIds ?? [])],
    ...(value ? { revision: value.revision } : {}),
  }
}

/** 与供应商连接边界一致，空白名称及带凭据/查询串的地址不能提交。 */
export function connectionDraftError(value: ConnectionDraft): string | null {
  if (!value.name.trim()) return '请填写连接名称。'
  try {
    const address = new URL(value.baseUrl.trim())
    if (
      !['http:', 'https:'].includes(address.protocol) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      return '请填写有效的供应商 API 地址，不包含账号、查询参数或片段。'
  } catch {
    return '请填写有效的供应商 API 地址。'
  }
  return null
}

/** 配置草稿缺少关键身份时保留弹窗，不把空表单交给网络请求。 */
export function configurationDraftError(
  value: ConfigurationDraft,
): string | null {
  if (!value.name.trim()) return '请填写配置名称。'
  if (!value.connectionId.trim()) return '请选择供应商连接。'
  if (!value.modelId.trim()) return '请填写模型 ID。'
  return null
}
