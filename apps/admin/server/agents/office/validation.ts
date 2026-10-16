import { inflateRawSync } from 'node:zlib'
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { OfficeInputError, type OfficeInputFile } from './types.ts'

export const OFFICE_LIMITS = {
  inputBytes: 10 * 1024 * 1024,
  expandedBytes: 40 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  entries: 600,
  rows: 5000,
  slides: 20,
  textCharacters: 100_000,
} as const

export function validateInput(file: OfficeInputFile, extensions: string[]) {
  if (!file || !Buffer.isBuffer(file.content) || !file.content.length) {
    throw new OfficeInputError('上传文件不能为空')
  }
  if (file.content.length > OFFICE_LIMITS.inputBytes) {
    throw new OfficeInputError('上传文件不能超过 10 MB')
  }
  if (
    typeof file.filename !== 'string' ||
    file.filename.length > 200 ||
    /[\\/\x00-\x1f]/u.test(file.filename)
  ) {
    throw new OfficeInputError('文件名无效，请只传文件名，不传本机路径')
  }
  const extension = file.filename
    .slice(file.filename.lastIndexOf('.'))
    .toLowerCase()
  if (!extensions.includes(extension)) {
    throw new OfficeInputError(`支持的文件格式：${extensions.join('、')}`)
  }
  return extension
}

export function textValue(value: unknown, label: string, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new OfficeInputError(
      `${label}不能为空，且不能超过 ${maxLength} 个字符`,
    )
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) {
    throw new OfficeInputError(`${label}含不支持的控制字符`)
  }
  return value.trim()
}

export function parseXml(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new OfficeInputError('不支持含 DTD 或实体定义的文档')
  }
  try {
    return new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') throw new Error(message)
      },
    }).parseFromString(xml, 'application/xml')
  } catch {
    throw new OfficeInputError('文档 XML 损坏，无法解析')
  }
}

/** Validate the ZIP directory before bounded inflation; never extract paths to disk. */
export function readOfficeArchive(file: OfficeInputFile) {
  validateInput(file, ['.xlsx', '.pptx', '.docx'])
  const bytes = file.content
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new OfficeInputError('文件不是有效的 Office ZIP 文档')
  const count = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  let offset = bytes.readUInt32LE(eocd + 16)
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== count ||
    count === 0 ||
    count > OFFICE_LIMITS.entries ||
    offset + centralSize !== eocd
  )
    throw new OfficeInputError('不支持多卷、ZIP64 或超出资源限制的文档')
  const archive = new JSZip()
  const names = new Set<string>()
  let expandedBytes = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new OfficeInputError('文档 ZIP 目录损坏')
    }
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressed = bytes.readUInt32LE(offset + 20)
    const expanded = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (
      end > eocd ||
      local + 30 > bytes.length ||
      bytes.readUInt32LE(local) !== 0x04034b50
    ) {
      throw new OfficeInputError('文档 ZIP 条目损坏')
    }
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
    if (
      !name ||
      name.includes('\ufffd') ||
      /[\\\x00-\x1f:]/u.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(name.toLowerCase()) ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new OfficeInputError(
        '文档含重复路径、危险路径、加密或不支持的压缩内容',
      )
    expandedBytes += expanded
    if (
      expanded > OFFICE_LIMITS.entryBytes ||
      expandedBytes > OFFICE_LIMITS.expandedBytes
    ) {
      throw new OfficeInputError('文档解压后超过资源限制')
    }
    const localNameLength = bytes.readUInt16LE(local + 26)
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28)
    if (
      start + compressed > bytes.readUInt32LE(eocd + 16) ||
      bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .toString('utf8') !== name ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new OfficeInputError('文档 ZIP 条目与目录不一致')
    let content: Buffer
    try {
      const packed = bytes.subarray(start, start + compressed)
      content =
        method === 0
          ? Buffer.from(packed)
          : inflateRawSync(packed, { maxOutputLength: Math.max(1, expanded) })
    } catch {
      throw new OfficeInputError('文档压缩内容损坏或超过资源限制')
    }
    if (content.length !== expanded)
      throw new OfficeInputError('文档解压长度与目录不一致')
    if (
      !name.endsWith('/') &&
      /vbaProject|activeX|embeddings\/|externalLinks\/|oleObject/iu.test(name)
    ) {
      throw new OfficeInputError(
        '不支持宏、嵌入对象或外部数据链接，请上传简化模板',
      )
    }
    if (/\.(?:xml|rels)$/iu.test(name)) {
      const document = parseXml(content.toString('utf8'))
      for (const relationship of Array.from(
        document.getElementsByTagNameNS('*', 'Relationship'),
      )) {
        if (
          relationship.getAttribute('TargetMode')?.toLowerCase() === 'external'
        ) {
          throw new OfficeInputError(
            '不支持外部链接或远程资源，请使用自包含文档',
          )
        }
      }
    }
    names.add(name.toLowerCase())
    archive.file(name, content)
    offset = end
  }
  if (offset !== eocd || !archive.file('[Content_Types].xml')) {
    throw new OfficeInputError('Office 文档目录不完整')
  }
  return archive
}
