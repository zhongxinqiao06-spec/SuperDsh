/** 会话附件沿用 JSON 内容契约；先校验编码，防止把错误正文保存为用户文件。 */
export function downloadContent(value: {
  contentBase64: string
  mediaType?: string
  contentType?: string
}): Blob {
  if (typeof value.contentBase64 !== 'string')
    throw new Error('附件内容格式无效')
  let binary: string
  try {
    binary = atob(value.contentBase64)
  } catch {
    throw new Error('附件内容编码无效')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], {
    type: value.mediaType || value.contentType || 'application/octet-stream',
  })
}
