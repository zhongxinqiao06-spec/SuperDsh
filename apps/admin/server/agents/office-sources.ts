import { createHash } from 'node:crypto'
import { ApiError, text } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import type { AgentBinding, AgentToolContext } from './contracts.ts'
import type { OfficeSource } from './office-contracts.ts'
import type { OfficeInputFile } from './office/types.ts'
import type { BusinessAgentService } from './service.ts'
import { decodeAgentAttachment } from './tool-context.ts'
import { readAssetContent } from '../files/asset-storage.ts'

export const officeHash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex')

export function officeJson(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value
  if (value.length > 200_000) throw new ApiError(422, `${name}过大`)
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    // Return only a position, not parser excerpts that could echo private input.
    const offset =
      error instanceof Error
        ? error.message.match(/position (\d+)/)?.[1]
        : undefined
    throw new ApiError(
      422,
      `${name}必须是有效 JSON${offset ? `（字符 ${offset} 附近）` : ''}；请检查数组/对象的闭合和引号转义，不要提交 Markdown 代码块。`,
    )
  }
}

export interface ResolvedOfficeSource {
  reference: OfficeSource
  file: OfficeInputFile
}

export async function resolveOfficeSources(
  service: BusinessAgentService,
  owner: string,
  binding: AgentBinding,
  args: Row,
  context: AgentToolContext,
  signal: AbortSignal,
): Promise<ResolvedOfficeSource[]> {
  const input = officeJson(args.inputsJson ?? args.inputs ?? [], '输入文件')
  if (!Array.isArray(input) || input.length > 10)
    throw new ApiError(422, '每次最多选择 10 个输入文件')
  const refs: unknown[] = [...input]
  if (args.dataAssetId) refs.push({ assetId: args.dataAssetId })
  if (args.attachmentName)
    refs.push({
      attachmentName: args.attachmentName,
      attachmentHash: args.attachmentHash,
    })
  if (args.templateAssetId)
    refs.push({ assetId: args.templateAssetId, role: 'template' })
  if (refs.length > 10) throw new ApiError(422, '每次最多选择 10 个输入文件')
  const results: ResolvedOfficeSource[] = []
  for (const value of refs) {
    signal.throwIfAborted()
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(422, '文件引用无效')
    const ref = value as Row
    const role = text(ref.role, 'input') as OfficeSource['role']
    if (!['input', 'template', 'knowledge', 'image'].includes(role))
      throw new ApiError(422, '文件用途无效')
    const keys = ['assetId', 'artifactId', 'attachmentName'].filter(
      (key) => ref[key] !== undefined,
    )
    if (keys.length !== 1)
      throw new ApiError(422, '每个文件必须明确指定一种来源')
    let file: OfficeInputFile, id: string, kind: OfficeSource['kind']
    if (keys[0] === 'assetId') {
      id = text(ref.assetId)
      const asset = binding.assets.find((item) => item.id === id)
      if (!asset) throw new ApiError(403, '资料未授权给当前智能体')
      const [row] = await service.options.db.query(
        'SELECT id,kind,name,sha256,content,file_storage_state FROM business_agent_assets WHERE id=$1 AND owner_user_id=$2',
        [id, binding.resourceOwnerId || owner],
      )
      if (!row || row.sha256 !== asset.sha256)
        throw new ApiError(409, '资料版本已变化，请新建会话后选择资料')
      file = {
        filename: text(row.name),
        content: await readAssetContent(service.options.files.library, row),
      }
      kind = 'asset'
    } else if (keys[0] === 'artifactId') {
      id = text(ref.artifactId)
      const [row] = await service.options.db.query(
        'SELECT id FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
        [id, binding.sessionId],
      )
      if (!row) throw new ApiError(404, '当前会话的成果不存在')
      const stored = await service.options.files.read(binding.sessionId, id)
      file = { filename: text(stored.metadata.name), content: stored.data }
      kind = 'artifact'
    } else {
      const name = text(ref.attachmentName),
        prefix = text(ref.attachmentHash)
      const attachments =
        context.attachments ?? (context.attachment ? [context.attachment] : [])
      const matches = attachments.filter(
        (item) =>
          item.name === name && (!prefix || item.sha256.startsWith(prefix)),
      )
      if (matches.length !== 1)
        throw new ApiError(422, '附件尚未接收或同名附件需指定哈希')
      file = decodeAgentAttachment(matches[0]!)
      id = `office_input_${officeHash(`${matches[0]!.sha256}:${file.filename}`)}`
      kind = 'attachment'
      await service.options.files.save(
        owner,
        binding.sessionId,
        file.filename,
        file.content,
        undefined,
        id,
      )
    }
    const reference = {
      id,
      kind,
      role,
      name: file.filename,
      sha256: officeHash(file.content),
      size: file.content.length,
    }
    if (
      results.some(
        (item) => item.reference.id === id && item.reference.role === role,
      )
    )
      throw new ApiError(422, '输入文件不能重复')
    results.push({ reference, file })
  }
  if (results.filter((item) => item.reference.role === 'template').length > 1)
    throw new ApiError(422, '每次请选择一个模板')
  return results
}

export async function loadOfficeSources(
  service: BusinessAgentService,
  owner: string,
  binding: AgentBinding,
  sources: OfficeSource[],
) {
  await service.options.hub.store.session(binding.sessionId, owner)
  const output: ResolvedOfficeSource[] = []
  for (const reference of sources) {
    let file: OfficeInputFile
    if (reference.kind === 'asset') {
      if (
        !binding.assets.some(
          (asset) =>
            asset.id === reference.id && asset.sha256 === reference.sha256,
        )
      )
        throw new ApiError(403, '方案资料已不属于本会话')
      const [row] = await service.options.db.query(
        'SELECT id,kind,name,content,file_storage_state FROM business_agent_assets WHERE id=$1 AND owner_user_id=$2',
        [reference.id, binding.resourceOwnerId || owner],
      )
      if (!row) throw new ApiError(404, '方案资料不存在')
      file = {
        filename: text(row.name),
        content: await readAssetContent(service.options.files.library, row),
      }
    } else {
      if (reference.kind === 'artifact') {
        const [row] = await service.options.db.query(
          'SELECT id FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
          [reference.id, binding.sessionId],
        )
        if (!row) throw new ApiError(404, '原成果已不可用')
      }
      const stored = await service.options.files.read(
        binding.sessionId,
        reference.id,
      )
      file = { filename: text(stored.metadata.name), content: stored.data }
    }
    if (
      file.filename !== reference.name ||
      file.content.length !== reference.size ||
      officeHash(file.content) !== reference.sha256
    )
      throw new ApiError(409, '输入文件已变化，请重新检查并确认方案')
    output.push({ reference, file })
  }
  return output
}
