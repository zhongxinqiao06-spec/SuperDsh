import { createHash } from 'node:crypto'
import { agentAttachmentMaxBytes } from './contracts.ts'

/** Only consumed user/message references authorize reads; inbox/staged files do not. */
export async function readSalesAttachment(args, execution, attachments) {
  if (args.attachmentName === undefined && args.attachmentHash === undefined)
    return undefined
  const name = args.attachmentName
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 200 ||
    /[\\/\x00-\x1f]/u.test(name) ||
    !/\.(csv|xlsx|pptx|txt|md|docx|pdf|png|jpe?g)$/iu.test(name)
  )
    throw new Error('请填写本会话办公附件的完整文件名，不要填写路径')
  const prefix = args.attachmentHash
  if (
    prefix !== undefined &&
    (typeof prefix !== 'string' || !/^[a-f0-9]{8,64}$/iu.test(prefix))
  )
    throw new Error('附件哈希应为文件提示中的至少 8 位 SHA256 十六进制值')
  execution.signal.throwIfAborted()
  if (!execution.agent || !attachments?.readFileStream)
    throw new Error('当前会话附件服务不可用')
  // Capture before the first await: later queued inputs must not change this call.
  const events = execution.agent.session.snapshotEvents()
  const matches = new Map()
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user')
      continue
    for (const part of event.data.content) {
      if (part.type !== 'file' || part.attachment?.name !== name) continue
      const ref = part.attachment
      if (
        !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes <= 0 ||
        ref.bytes > agentAttachmentMaxBytes
      )
        throw new Error('办公附件无效或超过 4 MiB')
      const hash = ref.attachmentId.slice('sha256:'.length)
      if (prefix && !hash.startsWith(prefix.toLowerCase())) continue
      if (!matches.has(hash))
        matches.set(hash, {
          ref: {
            attachmentId: ref.attachmentId,
            name: ref.name,
            bytes: ref.bytes,
          },
          hash,
          sourceMessageId: event.data.id,
          sourceSeq: Number(event.seq),
        })
    }
  }
  if (!matches.size)
    throw new Error('当前会话尚无已接收的该附件，请核对文件名后重试')
  if (matches.size !== 1)
    throw new Error(
      '同名附件包含不同内容，请指定文件提示中的 SHA256 或重新命名',
    )
  const selected = matches.values().next().value
  const chunks = []
  let size = 0
  for await (const value of attachments.readFileStream(
    selected.ref,
    execution.signal,
  )) {
    execution.signal.throwIfAborted()
    const chunk = Buffer.from(value)
    size += chunk.length
    if (size > selected.ref.bytes || size > agentAttachmentMaxBytes)
      throw new Error('办公附件大小与会话记录不一致')
    chunks.push(chunk)
  }
  execution.signal.throwIfAborted()
  const bytes = Buffer.concat(chunks)
  if (
    size !== selected.ref.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== selected.hash
  )
    throw new Error('办公附件内容与会话记录不一致')
  return {
    name,
    size,
    sha256: selected.hash,
    contentBase64: bytes.toString('base64'),
    sourceMessageId: selected.sourceMessageId,
    sourceSeq: selected.sourceSeq,
  }
}

export async function readOfficeAttachments(args, execution, attachments) {
  const refs =
    typeof args.inputsJson === 'string' ? JSON.parse(args.inputsJson) : []
  if (!Array.isArray(refs) || refs.length > 10)
    throw new Error('每次最多选择 10 个输入文件')
  if (args.attachmentName)
    refs.push({
      attachmentName: args.attachmentName,
      attachmentHash: args.attachmentHash,
    })
  const output = []
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') throw new Error('输入文件引用无效')
    if (ref.attachmentName !== undefined || ref.attachmentHash !== undefined) {
      const file = await readSalesAttachment(ref, execution, attachments)
      if (
        file &&
        !output.some(
          (item) => item.name === file.name && item.sha256 === file.sha256,
        )
      )
        output.push(file)
    }
  }
  return output
}
