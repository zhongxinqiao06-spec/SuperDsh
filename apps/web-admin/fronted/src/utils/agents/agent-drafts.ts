import type { AgentDefinition, AgentDraft } from '@/types/agents/agents'

/** 明确挑选写字段，历史时间和资源身份不能混入编辑请求。 */
export function agentDraft(value?: AgentDefinition): AgentDraft {
  return {
    name: value?.name ?? '',
    description: value?.description ?? '',
    instructions: value?.instructions ?? '',
    recommendedPrompts: [...(value?.recommendedPrompts ?? [])],
    inputRequirements: [...(value?.inputRequirements ?? [])],
    outputExamples: [...(value?.outputExamples ?? [])],
    knowledgeBaseIds: [...(value?.knowledgeBaseIds ?? [])],
    knowledgeAssetIds: [...(value?.knowledgeAssetIds ?? [])],
    templateAssetIds: [...(value?.templateAssetIds ?? [])],
    skillIds: [...(value?.skillIds ?? [])],
    toolIds: [...(value?.toolIds ?? [])],
    published: value?.published ?? false,
    ...(value?.skillPolicy ? { skillPolicy: { ...value.skillPolicy } } : {}),
    ...(value ? { version: value.version } : {}),
  }
}
/** 多行说明去除空白行，保留每条的原有顺序。 */
export function textLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
/** 浏览器文件只读编码，大小限制先于读取，避免超大 Base64 内存。 */
export async function assetBase64(file: File): Promise<string> {
  if (!file.size || file.size > 4 * 1024 * 1024)
    throw new Error('文件必须非空且不超过 4 MiB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return btoa(binary)
}
