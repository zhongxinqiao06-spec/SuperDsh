import { ApiError, requiredText, text } from '../http/api-router.ts'
import { agentTools, type AgentDefinition } from './contracts.ts'

function ids(
  value: unknown,
  name: string,
  allowed?: readonly string[],
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[\w-]{1,100}$/.test(id) ||
        (allowed && !allowed.includes(id)),
    )
  )
    throw new ApiError(422, `${name} 包含无效或未支持的选项`)
  if (new Set(value).size !== value.length)
    throw new ApiError(422, `${name} 不能重复`)
  return value as string[]
}

export function agentInput(
  body: Record<string, unknown>,
): Omit<AgentDefinition, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  if (typeof body.published !== 'boolean')
    throw new ApiError(422, 'published 必须是布尔值')
  const result = {
    name: requiredText(body.name, '智能体名称', 80).trim(),
    description: text(body.description).trim(),
    instructions: requiredText(body.instructions, '任务说明', 6000).trim(),
    knowledgeBaseIds: ids(body.knowledgeBaseIds ?? [], '知识库'),
    knowledgeAssetIds: ids(body.knowledgeAssetIds ?? [], '知识资料'),
    templateAssetIds: ids(body.templateAssetIds ?? [], '模板'),
    skillIds: ids(body.skillIds ?? [], '技能'),
    toolIds: ids(
      body.toolIds ?? [],
      '工具',
      agentTools.map((item) => item.id),
    ),
    published: body.published,
  }
  if (!result.name || !result.instructions || result.description.length > 500)
    throw new ApiError(422, '名称、说明或用途长度无效')
  return result
}

export function decodedAsset(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > 6 * 1024 * 1024 ||
    !value.length ||
    value.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(value)
  )
    throw new ApiError(422, '文件内容格式无效')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value)
    throw new ApiError(422, '文件内容格式无效')
  if (bytes.length > 4 * 1024 * 1024)
    throw new ApiError(413, '文件不能超过 4 MiB')
  return bytes
}
