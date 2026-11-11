import type {
  RuntimeCatalog,
  RuntimeCatalogItem,
} from '@/types/workbench/models'

/** 能力目录以显式字段为准，同时保留旧 metadata 声明的禁用原因。 */
export function catalogItemEnabled(item: RuntimeCatalogItem): boolean {
  if (typeof item.enabled === 'boolean') return item.enabled
  return typeof item.metadata?.enabled === 'boolean'
    ? item.metadata.enabled
    : true
}

export function catalogItemDisabledReason(
  item: RuntimeCatalogItem,
): string | null {
  if (typeof item.disabledReason === 'string' && item.disabledReason.trim())
    return item.disabledReason.trim()
  const reason = item.metadata?.disabledReason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null
}

const permissionNames: Record<string, string> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
}

export function catalogLabel(item: RuntimeCatalogItem): string {
  const preset = item.metadata?.preset
  return (
    (typeof preset === 'string' ? permissionNames[preset] : undefined) ??
    item.displayName ??
    item.label ??
    item.name ??
    item.id
  )
}

/** 模型名称与连接来源分开展示；同名个人／平台模型可区分，不泄露内部供应商标识。 */
export function modelCatalogSource(item: RuntimeCatalogItem): string {
  const provider = item.metadata?.providerName
  const source = item.metadata?.source
  return [
    source === 'personal'
      ? '个人配置'
      : source === 'platform'
        ? '平台配置'
        : '',
    typeof provider === 'string' ? provider : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function modelCatalogDisplayName(
  item: RuntimeCatalogItem,
  models: readonly RuntimeCatalogItem[],
  label: string,
  defaultReasoningLabel: string,
): string {
  const provider = item.metadata?.provider,
    model = item.metadata?.model
  if (!provider || !model || item.metadata?.reasoningEffort !== null)
    return label
  const explicit = models.some(
    (candidate) =>
      candidate.metadata?.provider === provider &&
      candidate.metadata?.model === model &&
      typeof candidate.metadata?.reasoningEffort === 'string' &&
      candidate.metadata.reasoningEffort.length > 0,
  )
  return explicit && !label.endsWith(` · ${defaultReasoningLabel}`)
    ? `${label} · ${defaultReasoningLabel}`
    : label
}

export function selectionIdForModelCatalog(
  catalog: RuntimeCatalog | null,
  modelId: string,
  reasoningId: string,
): string | null {
  const model = (catalog?.models ?? catalog?.items)?.find(
    (item) => item.id === modelId,
  )
  if (!model || !catalogItemEnabled(model)) return null
  if (reasoningId) {
    const reasoning = model.reasoningItems?.find(
      (item) => item.id === reasoningId,
    )
    return reasoning && catalogItemEnabled(reasoning)
      ? (reasoning.selectionId ?? null)
      : null
  }
  return (
    model.selectionId ??
    model.reasoningItems?.find(
      (item) => item.default && catalogItemEnabled(item),
    )?.selectionId ??
    null
  )
}

export function modelIdsForSelectionId(
  catalog: RuntimeCatalog | null,
  selectionId: string | null | undefined,
  includeDisabled = false,
): { modelId: string; reasoningId: string } | null {
  if (!selectionId) return null
  for (const model of catalog?.models ?? catalog?.items ?? []) {
    if (!includeDisabled && !catalogItemEnabled(model)) continue
    if (model.selectionId === selectionId)
      return { modelId: model.id, reasoningId: '' }
    const reasoning = model.reasoningItems?.find(
      (item) =>
        item.selectionId === selectionId &&
        (includeDisabled || catalogItemEnabled(item)),
    )
    if (reasoning) return { modelId: model.id, reasoningId: reasoning.id }
  }
  return null
}

export function selectionIdForPermissionCatalog(
  catalog: RuntimeCatalog | null,
  permissionId: string,
): string | null {
  return (
    (catalog?.permissions ?? catalog?.items)?.find(
      (item) => item.id === permissionId && catalogItemEnabled(item),
    )?.selectionId ?? null
  )
}

export function permissionIdForSelectionId(
  catalog: RuntimeCatalog | null,
  selectionId: string | null | undefined,
  includeDisabled = false,
): string {
  if (!selectionId) return ''
  return (
    (catalog?.permissions ?? catalog?.items)?.find(
      (item) =>
        item.selectionId === selectionId &&
        (includeDisabled || catalogItemEnabled(item)),
    )?.id ?? ''
  )
}
