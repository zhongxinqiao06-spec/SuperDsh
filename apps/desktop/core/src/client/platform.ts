import type {
  PlatformAgentBinding,
  PlatformAgentDefinition,
  PlatformBridge,
  PlatformJson,
} from '../contracts/platform.ts'
export type * from '../contracts/platform.ts'
/** Only the trusted product renderer has this capability. */
export function platformBridge(): PlatformBridge | undefined {
  return (
    globalThis as typeof globalThis & { superdshPlatform?: PlatformBridge }
  ).superdshPlatform
}

/** Published product definitions are data; they never select a client module or Host path. */
export function platformAgentDefinitions(
  value: PlatformJson,
): PlatformAgentDefinition[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  if (!Array.isArray(value.items)) return []
  const definitions = new Map<string, PlatformAgentDefinition>()
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.published !== true ||
      typeof item.version !== 'number' ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    )
      continue
    const list = (key: string): string[] =>
      Array.isArray(item[key])
        ? item[key].filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : []
    definitions.set(item.id, {
      id: item.id,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      instructions:
        typeof item.instructions === 'string' ? item.instructions : '',
      knowledgeAssetIds: list('knowledgeAssetIds'),
      templateAssetIds: list('templateAssetIds'),
      skillIds: list('skillIds'),
      toolIds: list('toolIds'),
      published: true,
      version: item.version,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })
  }
  return [...definitions.values()]
}

export function platformAgentBinding(
  value: PlatformJson | undefined,
): PlatformAgentBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    return null
  return { id: value.id, name: value.name, version: value.version }
}

export function platformAgentCreation(
  executorKind: 'desktop' | 'server-agent',
  sessionId: string,
  selectedId: string,
  definitions: readonly PlatformAgentDefinition[],
): { agentDefinitionId?: string } {
  if (!selectedId) return {}
  if (executorKind !== 'server-agent' || sessionId)
    throw new Error(
      '产品智能体仅可用于新建服务端会话，已有会话的智能体版本不可切换',
    )
  if (!definitions.some((agent) => agent.id === selectedId && agent.published))
    throw new Error('所选智能体已不可用，请刷新后重新选择')
  return { agentDefinitionId: selectedId }
}
