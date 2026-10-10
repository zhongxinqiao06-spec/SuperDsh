import type { ProtocolModelItem } from './types'
import type { ModelSelection } from '../management/models-api'

/** Use the runtime's opaque selection ID; the platform default is a logical pair. */
export function serverAgentDefaultModel(
  models: readonly ProtocolModelItem[],
  selection: ModelSelection | null,
): ProtocolModelItem | undefined {
  if (!selection) return undefined
  const matches = models.filter((model) => {
    const provider = model.metadata.provider
    return (
      model.enabled !== false &&
      model.metadata.enabled !== false &&
      typeof provider === 'string' &&
      /^superdsh-[a-f0-9]{64}-(.+)$/.exec(provider)?.[1] ===
        selection.providerId &&
      model.metadata.model === selection.modelId &&
      !model.metadata.reasoningEffort &&
      !!model.selectionId
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}
