import { object, string, type Row } from './platform-model.ts'

/** The target owns its model route; origin aliases may give it a different scope. */
export function remotePlatformDefault(
  models: readonly Row[],
  platformDefault: Row,
): Row | undefined {
  const matches = models.filter((row) => {
    const metadata = object(row.metadata)
    const provider = string(metadata.provider)
    const logicalProvider = /^superdsh-[a-f0-9]{64}-(.+)$/.exec(provider)?.[1]
    return (
      logicalProvider === string(platformDefault.providerId) &&
      metadata.model === platformDefault.modelId &&
      !metadata.reasoningEffort
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}
