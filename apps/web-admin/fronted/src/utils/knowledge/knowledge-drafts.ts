import type {
  EmbeddingDraft,
  EmbeddingSettings,
  KnowledgeBase,
  KnowledgeDraft,
  KnowledgeSource,
} from '@/types/knowledge/knowledge'

/** 编辑只带写字段和当前版本，取消不会改变列表资源。 */
export function knowledgeDraft(value?: KnowledgeBase): KnowledgeDraft {
  return {
    name: value?.name ?? '',
    description: value?.description ?? '',
    enabled: value?.enabled ?? true,
    assetIds: [...(value?.assetIds ?? [])],
    ...(value ? { version: value.version } : {}),
  }
}
/** 密钥不会从公开设置复制回表单。 */
export function embeddingDraft(value?: EmbeddingSettings): EmbeddingDraft {
  return {
    version: value?.version ?? 0,
    kind: value?.profile.kind ?? 'local',
    model: value?.profile.model ?? '',
    dimensions: value?.profile.dimensions ?? 512,
    revision: value?.profile.revision ?? '',
    baseUrl: value?.profile.baseUrl ?? '',
    apiKey: '',
    clearApiKey: false,
  }
}
/** 位置只展示解析器实际返回字段，不从普通文本猜测页码。 */
export function sourceLocation(source: KnowledgeSource): string {
  const value = source.location
  return (
    [
      value.heading,
      value.page ? `第 ${value.page} 页` : '',
      value.paragraph ? `第 ${value.paragraph} 段` : '',
      value.sheet ? `工作表 ${value.sheet}` : '',
      value.row
        ? `第 ${value.row} 行`
        : value.line
          ? `原文第 ${value.line} 行`
          : '',
    ]
      .filter(Boolean)
      .join(' · ') || '原文片段'
  )
}
