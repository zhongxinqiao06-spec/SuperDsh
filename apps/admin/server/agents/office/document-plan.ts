import { OfficeInputError } from './types.ts'
import { textValue } from './validation.ts'

export type DocumentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; columns: string[]; rows: string[][]; caption?: string }
  | { type: 'image'; imageId: string; caption?: string }
  | { type: 'quote'; text: string; sourceId: string }
export interface OfficeDocumentPlan {
  title: string
  subtitle?: string
  purpose?: string
  brand: { company?: string; accentColor: string; fontFace?: string }
  tableOfContents: boolean
  sections: {
    id: string
    title: string
    level: 1 | 2 | 3
    pageBreakBefore: boolean
    blocks: DocumentBlock[]
  }[]
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OfficeInputError('Word 方案字段必须为对象')
  return value as Record<string, unknown>
}
const optional = (value: unknown, label: string, max = 300) =>
  value === undefined ? undefined : textValue(value, label, max)
function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw new OfficeInputError(`${label}需为 1–${max} 项`)
  return value
}
export function validateOfficeDocumentPlan(value: unknown): OfficeDocumentPlan {
  const input = record(value),
    brand = record(input.brand ?? {})
  const color = brand.accentColor ?? '214D66'
  if (typeof color !== 'string' || !/^[\da-f]{6}$/iu.test(color))
    throw new OfficeInputError('Word 主题色需为六位十六进制颜色')
  const fontFace = optional(brand.fontFace, '字体', 80)
  if (fontFace && /[<>\\/]/u.test(fontFace))
    throw new OfficeInputError('字体名称无效')
  const ids = new Set<string>()
  let characters = 0
  const sections = list(input.sections, '章节', 60).map(
    (raw): OfficeDocumentPlan['sections'][number] => {
      const section = record(raw)
      const id = textValue(section.id, '章节标识', 100)
      if (ids.has(id)) throw new OfficeInputError('章节标识不能重复')
      ids.add(id)
      const level = section.level ?? 1
      if (level !== 1 && level !== 2 && level !== 3)
        throw new OfficeInputError('标题级别只能为 1、2、3')
      const blocks: DocumentBlock[] = list(section.blocks, '章节内容', 100).map(
        (rawBlock) => {
          const block = record(rawBlock)
          if (block.type === 'paragraph')
            return {
              type: 'paragraph',
              text: textValue(block.text, '段落', 8000),
            }
          if (block.type === 'quote')
            return {
              type: 'quote',
              text: textValue(block.text, '引用', 3000),
              sourceId: textValue(block.sourceId, '引用资料标识', 200),
            }
          if (block.type === 'image')
            return {
              type: 'image',
              imageId: textValue(block.imageId, '图片标识', 200),
              caption: optional(block.caption, '图注'),
            }
          if (block.type === 'list')
            return {
              type: 'list',
              items: list(block.items, '列表', 60).map((item) =>
                textValue(item, '列表项', 1000),
              ),
              ordered: block.ordered === true,
            }
          if (block.type === 'table') {
            const columns = list(block.columns, '表头', 8).map((item) =>
              textValue(item, '表头', 100),
            )
            const rows = list(block.rows, '表格行', 300).map((rawRow) => {
              if (!Array.isArray(rawRow) || rawRow.length !== columns.length)
                throw new OfficeInputError('表格每行列数需与表头一致')
              return rawRow.map((item) =>
                item === ''
                  ? ''
                  : textValue(
                      typeof item === 'number' ? String(item) : item,
                      '单元格',
                      800,
                    ),
              )
            })
            return {
              type: 'table',
              columns,
              rows,
              caption: optional(block.caption, '表注'),
            }
          }
          throw new OfficeInputError(
            'Word 内容只支持段落、列表、表格、图片和引用',
          )
        },
      )
      characters += JSON.stringify(blocks).length
      return {
        id,
        title: textValue(section.title, '章节标题', 160),
        level,
        pageBreakBefore: section.pageBreakBefore === true,
        blocks,
      }
    },
  )
  if (characters > 150000)
    throw new OfficeInputError('单份 Word 方案正文过长，请拆分文档')
  if (
    input.tableOfContents !== undefined &&
    typeof input.tableOfContents !== 'boolean'
  )
    throw new OfficeInputError('目录开关需为布尔值')
  return {
    title: textValue(input.title, '文档标题', 120),
    subtitle: optional(input.subtitle, '副标题'),
    purpose: optional(input.purpose, '文档用途'),
    brand: {
      company: optional(brand.company, '公司名称', 100),
      accentColor: color.toUpperCase(),
      fontFace,
    },
    tableOfContents: input.tableOfContents !== false,
    sections,
  }
}
