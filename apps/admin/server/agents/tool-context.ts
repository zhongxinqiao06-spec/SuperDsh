import { createHash } from 'node:crypto'
import { ApiError } from '../http/api-router.ts'
import { agentAttachmentMaxBytes, type AgentToolContext } from './contracts.ts'

/** Parse only the separate Host IPC field, never an object supplied in tool args. */
export function parseAgentToolContext(value: unknown): AgentToolContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, '缺少业务工具执行上下文')
  const input = value as Record<string, unknown>
  for (const key of ['sessionId', 'presetId', 'callId']) {
    if (
      typeof input[key] !== 'string' ||
      !input[key] ||
      input[key].length > 300
    )
      throw new ApiError(422, '无效业务工具执行上下文')
  }
  const context: AgentToolContext = {
    sessionId: input.sessionId as string,
    presetId: input.presetId as string,
    callId: input.callId as string,
  }
  if (input.attachment === undefined) return context
  if (
    !input.attachment ||
    typeof input.attachment !== 'object' ||
    Array.isArray(input.attachment)
  )
    throw new ApiError(422, '无效业务附件上下文')
  const file = input.attachment as Record<string, unknown>
  if (
    typeof file.name !== 'string' ||
    !file.name ||
    file.name.length > 200 ||
    /[\\/\x00-\x1f]/u.test(file.name) ||
    !/\.(csv|xlsx)$/iu.test(file.name) ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > agentAttachmentMaxBytes ||
    typeof file.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(file.sha256) ||
    typeof file.sourceMessageId !== 'string' ||
    !file.sourceMessageId ||
    file.sourceMessageId.length > 1000 ||
    typeof file.sourceSeq !== 'number' ||
    !Number.isSafeInteger(file.sourceSeq) ||
    file.sourceSeq < 0 ||
    typeof file.contentBase64 !== 'string' ||
    file.contentBase64.length > Math.ceil(agentAttachmentMaxBytes / 3) * 4 ||
    file.contentBase64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(file.contentBase64)
  )
    throw new ApiError(422, '业务附件无效或超过 4 MiB')
  context.attachment = {
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    contentBase64: file.contentBase64,
    sourceMessageId: file.sourceMessageId,
    sourceSeq: file.sourceSeq,
  }
  return context
}

export function decodeAgentAttachment(
  file: NonNullable<AgentToolContext['attachment']>,
) {
  const bytes = Buffer.from(file.contentBase64, 'base64')
  if (
    bytes.toString('base64') !== file.contentBase64 ||
    bytes.length !== file.size ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new ApiError(422, '业务附件内容与执行上下文不一致')
  return { filename: file.name, content: bytes }
}
