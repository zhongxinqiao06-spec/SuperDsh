import ExcelJS from 'exceljs'
import { fileURLToPath } from 'node:url'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import {
  OFFICE_LIMITS,
  parseXml,
  readOfficeArchive,
  validateInput,
} from './validation.ts'
import type { KnowledgeSegment } from '../knowledge-contracts.ts'

function decode(content: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(content)
      .replace(/^\uFEFF/u, '')
  } catch {
    throw new OfficeInputError('知识文本必须使用 UTF-8 编码')
  }
}

function csvSegments(content: Buffer): KnowledgeSegment[] {
  const input = decode(content)
  const result: KnowledgeSegment[] = []
  let values: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    row = 1
  const finishField = () => {
    if (values.length >= 64)
      throw new OfficeInputError('知识表格最多支持 64 列')
    values.push(field)
    field = ''
    closed = false
  }
  const finishRow = () => {
    finishField()
    if (values.some((value) => value.trim()))
      result.push({ text: values.join('\t'), location: { sheet: 'CSV', row } })
    row++
    if (row > OFFICE_LIMITS.rows + 2)
      throw new OfficeInputError('知识表格不能超过 5000 条数据')
    values = []
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
        closed = true
      } else field += c
    } else if (c === '"' && !field && !closed) quoted = true
    else if (c === ',') finishField()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++
      finishRow()
    } else if (closed || c === '"')
      throw new OfficeInputError('CSV 引号格式不正确')
    else field += c
    if (field.length > 4000)
      throw new OfficeInputError('单个知识单元格不能超过 4000 字符')
  }
  if (quoted) throw new OfficeInputError('CSV 引号未闭合')
  if (field || values.length || closed) finishRow()
  return result
}

function cellText(value: ExcelJS.CellValue, address: string): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if ('richText' in value)
    return value.richText.map((part) => part.text).join('')
  if ('hyperlink' in value) return value.text
  if ('error' in value)
    throw new OfficeInputError(`${address} 含错误值，请修正后上传`)
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined || value.result === null)
      throw new OfficeInputError(
        `${address} 的公式没有已保存的计算结果，请在表格软件重算并保存`,
      )
    return cellText(value.result, address)
  }
  throw new OfficeInputError(`${address} 含无法提取的单元格类型`)
}

async function workbookSegments(
  file: OfficeInputFile,
): Promise<KnowledgeSegment[]> {
  const archive = readOfficeArchive(file)
  if (!archive.file('xl/workbook.xml'))
    throw new OfficeInputError('文件不是 XLSX 工作簿')
  const sheets = archive.file(/^xl\/worksheets\/[^/]+\.xml$/u)
  if (sheets.length > 40)
    throw new OfficeInputError('知识工作簿最多支持 40 个工作表')
  let cells = 0
  for (const part of sheets) {
    const document = parseXml(await part.async('string'))
    for (const cell of Array.from(document.getElementsByTagName('c'))) {
      const address = /^([A-Z]+)(\d+)$/u.exec(cell.getAttribute('r') ?? '')
      const column =
        address?.[1]
          ?.split('')
          .reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) ?? 0
      if (
        !address ||
        Number(address[2]) > 5020 ||
        column > 64 ||
        ++cells > 100000
      )
        throw new OfficeInputError(
          '知识表格超出支持范围：每表 5020 行、64 列，总计 100000 单元格',
        )
    }
  }
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Uint8Array.from(file.content).buffer)
  } catch {
    throw new OfficeInputError('无法读取 XLSX 文件，请确认文件未损坏')
  }
  const result: KnowledgeSegment[] = []
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, rowNumber) => {
      const values: string[] = []
      for (let index = 1; index <= Math.min(sheet.columnCount, 64); index++) {
        const cell = row.getCell(index)
        values.push(cellText(cell.value, `${sheet.name}!${cell.address}`))
      }
      if (values.some((value) => value.trim()))
        result.push({
          text: values.join('\t'),
          location: { sheet: sheet.name, row: rowNumber },
        })
    })
  }
  return result
}

async function pdfSegments(file: OfficeInputFile): Promise<KnowledgeSegment[]> {
  if (!file.content.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new OfficeInputError('文件不是有效的 PDF 文档')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: Uint8Array.from(file.content),
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: fileURLToPath(
      new URL(
        '../../standard_fonts/',
        import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      ),
    ).replaceAll('\\', '/'),
    cMapUrl: fileURLToPath(
      new URL(
        '../../cmaps/',
        import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      ),
    ).replaceAll('\\', '/'),
    cMapPacked: true,
  })
  try {
    const document = await task.promise
    if (document.numPages > 200)
      throw new OfficeInputError('PDF 最多支持 200 页，请拆分后上传')
    const result: KnowledgeSegment[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
      if (text.trim())
        result.push({ text: text.trim(), location: { page: pageNumber } })
      page.cleanup()
    }
    if (!result.length)
      throw new OfficeInputError(
        'PDF 没有可提取文字，扫描件需要先进行 OCR 后上传',
      )
    return result
  } catch (error) {
    if (error instanceof OfficeInputError) throw error
    if (
      error instanceof Error &&
      /password|encrypted/i.test(`${error.name} ${error.message}`)
    )
      throw new OfficeInputError('暂不支持加密 PDF，请解密后上传')
    throw new OfficeInputError('PDF 损坏或无法读取文字，请确认文件内容')
  } finally {
    await task.destroy()
  }
}

export async function parseKnowledgeFile(file: OfficeInputFile) {
  const extension = validateInput(file, [
    '.txt',
    '.md',
    '.csv',
    '.xlsx',
    '.docx',
    '.pdf',
  ])
  let segments: KnowledgeSegment[]
  if (extension === '.csv') segments = csvSegments(file.content)
  else if (extension === '.xlsx') segments = await workbookSegments(file)
  else if (extension === '.pdf') segments = await pdfSegments(file)
  else if (extension === '.docx') {
    const archive = readOfficeArchive(file)
    const part = archive.file('word/document.xml')
    if (!part) throw new OfficeInputError('文件不是有效的 DOCX 文档')
    const document = parseXml(await part.async('string'))
    const namespace =
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const headings = new Set<string>()
    const stylesPart = archive.file('word/styles.xml')
    if (stylesPart) {
      const styles = parseXml(await stylesPart.async('string'))
      for (const style of Array.from(
        styles.getElementsByTagNameNS(namespace, 'style'),
      )) {
        const name =
          style
            .getElementsByTagNameNS(namespace, 'name')[0]
            ?.getAttributeNS(namespace, 'val') ?? ''
        const outline = style
          .getElementsByTagNameNS(namespace, 'outlineLvl')[0]
          ?.getAttributeNS(namespace, 'val')
        const id = style.getAttributeNS(namespace, 'styleId')
        if (
          id &&
          (/heading|标题/i.test(name) ||
            (outline !== null && outline !== undefined && Number(outline) < 9))
        )
          headings.add(id)
      }
    }
    let heading: string | undefined
    segments = Array.from(document.getElementsByTagNameNS(namespace, 'p')).map(
      (paragraph, index) => {
        const text = Array.from(
          paragraph.getElementsByTagNameNS(namespace, '*'),
        )
          .map((node) =>
            node.localName === 't'
              ? (node.textContent ?? '')
              : node.localName === 'tab'
                ? '\t'
                : ['br', 'cr'].includes(node.localName ?? '')
                  ? '\n'
                  : '',
          )
          .join('')
        const style = paragraph
          .getElementsByTagNameNS(namespace, 'pStyle')[0]
          ?.getAttributeNS(namespace, 'val')
        if (style && (/heading|标题/i.test(style) || headings.has(style)))
          heading = text
        return {
          text,
          location: { paragraph: index + 1, ...(heading ? { heading } : {}) },
        }
      },
    )
  } else {
    let heading: string | undefined
    segments = decode(file.content)
      .split(/\r?\n/u)
      .map((text, index) => {
        if (extension === '.md') {
          const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(text)
          if (match) heading = match[1]
        }
        return {
          text,
          location: {
            line: index + 1,
            paragraph: index + 1,
            ...(heading ? { heading } : {}),
          },
        }
      })
  }
  segments = segments
    .map((part) => ({ ...part, text: part.text.trim() }))
    .filter((part) => part.text)
  const text = segments.map((part) => part.text).join('\n')
  if (
    !text ||
    text.length > OFFICE_LIMITS.textCharacters ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)
  )
    throw new OfficeInputError(
      '知识文本为空、含控制字符或超过 100000 字符，请拆分后上传',
    )
  return { filename: file.filename, text, segments }
}
