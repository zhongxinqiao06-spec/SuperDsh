import { open } from 'node:fs/promises'
import { ApiError } from '../http/api-router.ts'

/** Inspect the ZIP directory from staged parts without buffering the uploaded Office file. */
export async function officeUploadType(
  parts: { path: string; size: number }[],
  size: number,
  name: string,
  claimed: string,
  signal: AbortSignal,
): Promise<string> {
  const read = async (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > size)
      throw new ApiError(422, '压缩文件目录损坏')
    const result = Buffer.alloc(length)
    let start = 0,
      copied = 0
    for (const part of parts) {
      const from = Math.max(offset, start),
        to = Math.min(offset + length, start + part.size)
      if (to > from) {
        signal.throwIfAborted()
        const file = await open(part.path, 'r')
        try {
          const { bytesRead } = await file.read(
            result,
            copied,
            to - from,
            from - start,
          )
          if (bytesRead !== to - from) throw new ApiError(422, '上传分片已损坏')
          copied += bytesRead
        } finally {
          await file.close()
        }
      }
      start += part.size
    }
    return result
  }
  const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557))
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--)
    if (
      tail.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + tail.readUInt16LE(i + 20) === tail.length
    ) {
      end = i
      break
    }
  if (end < 0) throw new ApiError(422, '压缩文件缺少有效目录')
  const count = tail.readUInt16LE(end + 10),
    length = tail.readUInt32LE(end + 12),
    offset = tail.readUInt32LE(end + 16)
  if (
    tail.readUInt16LE(end + 4) ||
    tail.readUInt16LE(end + 6) ||
    count === 65535 ||
    length > 8 * 1024 * 1024
  )
    throw new ApiError(422, '暂不支持多卷、ZIP64 或超大目录的 Office 文件')
  const directory = await read(offset, length),
    names = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (
      cursor + 46 > directory.length ||
      directory.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new ApiError(422, '压缩文件目录损坏')
    if (directory.readUInt16LE(cursor + 8) & 1)
      throw new ApiError(422, '不支持加密 Office 文件')
    const nameLength = directory.readUInt16LE(cursor + 28)
    const next =
      cursor +
      46 +
      nameLength +
      directory.readUInt16LE(cursor + 30) +
      directory.readUInt16LE(cursor + 32)
    if (next > directory.length) throw new ApiError(422, '压缩文件目录损坏')
    const entry = directory
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')
    if (names.has(entry)) throw new ApiError(422, '压缩文件包含重复条目')
    names.add(entry)
    cursor = next
  }
  const types = [
    ['word/document.xml', 'docx', 'wordprocessingml.document'],
    ['ppt/presentation.xml', 'pptx', 'presentationml.presentation'],
    ['xl/workbook.xml', 'xlsx', 'spreadsheetml.sheet'],
  ]
  const selected = types.filter(([entry]) => names.has(entry!))
  const extension = name.split('.').at(-1)?.toLowerCase()
  const office =
    selected.length === 1 && names.has('[Content_Types].xml')
      ? selected[0]
      : undefined
  const actual = office
    ? 'application/vnd.openxmlformats-officedocument.' + office[2]
    : 'application/zip'
  if (
    (['docx', 'pptx', 'xlsx'].includes(extension || '') &&
      extension !== office?.[1]) ||
    (claimed &&
      claimed !== 'application/octet-stream' &&
      claimed.split(';')[0] !== actual)
  )
    throw new ApiError(422, 'Office 文件类型与实际内容不一致')
  return actual
}
