import { OfficeInputError } from './types.ts'
import { OFFICE_LIMITS, textValue } from './validation.ts'
import type { PresentationRegion } from './presentation-template.ts'
import {
  validatePresentationDesign,
  type PresentationDesign,
} from './presentation-design-plan.ts'
import {
  validatePresentationTheme,
  type PresentationDesignTheme,
} from './design-themes.ts'

export interface OfficePresentationPlan {
  title: string
  audience?: string
  purpose?: string
  designTheme?: PresentationDesignTheme
  brand?: {
    company?: string
    fontFace?: string
    accentColor?: string
    textColor?: string
    backgroundColor?: string
  }
  slides: OfficePresentationSlide[]
}

export interface OfficePresentationSlide {
  id: string
  kind: 'title' | 'content' | 'table' | 'chart' | 'image' | 'design'
  design?: PresentationDesign
  title: string
  body?: string[]
  table?: { columns: string[]; rows: (string | number)[][] }
  chart?: {
    type: 'bar' | 'line' | 'pie'
    categories: string[]
    series: { name: string; values: number[] }[]
    valueUnit?: string
  }
  imageId?: string
  notes?: string
  sourceIds?: string[]
  template?: {
    slide: number
    titleShape?: string
    bodyShape?: string
    contentRegion?: PresentationRegion
  }
}

export interface PresentationDiagnostic {
  severity: 'warning' | 'info'
  code: string
  message: string
  slideId?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OfficeInputError(`${label}必须为对象`)
  return value as Record<string, unknown>
}

function optionalText(value: unknown, label: string, limit = 200) {
  return value === undefined ? undefined : textValue(value, label, limit)
}

function list(value: unknown, label: string, max: number) {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw new OfficeInputError(`${label}需为 1–${max} 项`)
  return value as unknown[]
}

function stringList(value: unknown, label: string, max: number, chars = 200) {
  return list(value, label, max).map((item) => textValue(item, label, chars))
}

function color(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{6}$/iu.test(value))
    throw new OfficeInputError(`${label}必须为六位十六进制颜色`)
  return value.toUpperCase()
}

function finite(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e15
  )
    throw new OfficeInputError(`${label}必须为有限数字，且绝对值不超过 10¹⁵`)
  return value
}

function mapping(value: unknown): OfficePresentationSlide['template'] {
  if (value === undefined) return undefined
  const item = record(value, '模板映射')
  const slide = finite(item.slide, '模板页码')
  if (!Number.isInteger(slide) || slide < 1 || slide > OFFICE_LIMITS.slides)
    throw new OfficeInputError('模板页码应为 1–20 的整数')
  let contentRegion: PresentationRegion | undefined
  if (item.contentRegion !== undefined) {
    const region = record(item.contentRegion, '模板内容区域')
    contentRegion = {
      x: finite(region.x, '区域横坐标'),
      y: finite(region.y, '区域纵坐标'),
      w: finite(region.w, '区域宽度'),
      h: finite(region.h, '区域高度'),
    }
    if (
      contentRegion.x < 0 ||
      contentRegion.y < 0 ||
      contentRegion.w <= 0 ||
      contentRegion.h <= 0
    )
      throw new OfficeInputError('模板内容区域需位于页面内并具有正尺寸')
  }
  return {
    slide,
    titleShape: optionalText(item.titleShape, '标题文本框名称'),
    bodyShape: optionalText(item.bodyShape, '正文文本框名称'),
    contentRegion,
  }
}

/** Only the bounded, typed plan crosses into the renderer; never execute model code. */
export function validateOfficePresentationPlan(
  value: unknown,
): OfficePresentationPlan {
  const input = record(value, 'PPT 方案')
  const title = textValue(input.title, '演示文稿标题', 120)
  let brand: OfficePresentationPlan['brand']
  if (input.brand !== undefined) {
    const item = record(input.brand, '品牌设置')
    brand = {
      company: optionalText(item.company, '公司名称', 80),
      fontFace: optionalText(item.fontFace, '字体', 80),
      accentColor: color(item.accentColor, '强调色'),
      textColor: color(item.textColor, '文字色'),
      backgroundColor: color(item.backgroundColor, '背景色'),
    }
    if (brand.fontFace && /[<>\\/]/u.test(brand.fontFace))
      throw new OfficeInputError('字体名称无效')
  }
  const ids = new Set<string>()
  const slides = list(input.slides, '幻灯片', OFFICE_LIMITS.slides).map(
    (value, index) => {
      const item = record(value, `第 ${index + 1} 页`)
      const id = textValue(item.id, '页面标识', 100)
      if (ids.has(id)) throw new OfficeInputError('页面标识不能重复')
      ids.add(id)
      const kind = item.kind
      if (
        kind !== 'title' &&
        kind !== 'content' &&
        kind !== 'table' &&
        kind !== 'chart' &&
        kind !== 'image' &&
        kind !== 'design'
      )
        throw new OfficeInputError(
          '页面类型应为 title、content、table、chart、image 或 design',
        )
      const result: OfficePresentationSlide = {
        id,
        kind,
        title: textValue(item.title, '页面标题', 120),
        body:
          item.body === undefined
            ? undefined
            : stringList(item.body, '正文段落', 12, 600),
        notes: optionalText(item.notes, '演讲备注', 4000),
        sourceIds:
          item.sourceIds === undefined
            ? undefined
            : stringList(item.sourceIds, '来源标识', 50, 200),
        template: mapping(item.template),
      }
      if (kind === 'design') {
        if (result.body?.length)
          throw new OfficeInputError('设计页正文请放到设计组件中，避免重复布局')
        result.design = validatePresentationDesign(
          item.design,
          (legacy) =>
            validateOfficePresentationPlan({ title, slides: [legacy] })
              .slides[0]!,
        )
      }
      if (kind === 'table') {
        const table = record(item.table, '表格')
        const columns = stringList(table.columns, '表格列', 8, 80)
        const rows = list(table.rows, '表格行', 15).map((value) => {
          if (!Array.isArray(value) || value.length !== columns.length)
            throw new OfficeInputError('表格每行的列数必须与表头一致')
          return (value as unknown[]).map((cell) =>
            typeof cell === 'number'
              ? finite(cell, '单元格数值')
              : cell === ''
                ? ''
                : textValue(cell, '单元格', 200),
          )
        })
        result.table = { columns, rows }
      }
      if (kind === 'chart') {
        const chart = record(item.chart, '图表')
        if (
          chart.type !== 'bar' &&
          chart.type !== 'line' &&
          chart.type !== 'pie'
        )
          throw new OfficeInputError('支持柱状图、折线图和饼图')
        const categories = stringList(chart.categories, '图表分类', 24, 60)
        const series = list(chart.series, '图表系列', 6).map((value) => {
          const series = record(value, '图表系列')
          if (
            !Array.isArray(series.values) ||
            series.values.length !== categories.length
          )
            throw new OfficeInputError('图表数据长度必须与分类一致')
          return {
            name: textValue(series.name, '系列名称', 80),
            values: (series.values as unknown[]).map((value) =>
              finite(value, '图表数据'),
            ),
          }
        })
        if (
          chart.type === 'pie' &&
          (series.length !== 1 ||
            series[0]!.values.some((value) => value < 0) ||
            !series[0]!.values.some((value) => value > 0))
        )
          throw new OfficeInputError(
            '饼图只支持一个系列，数值不能为负且总和应大于零',
          )
        result.chart = {
          type: chart.type,
          categories,
          series,
          valueUnit: optionalText(chart.valueUnit, '数值单位', 40),
        }
      }
      if (kind === 'image')
        result.imageId = textValue(item.imageId, '图片引用', 200)
      if (kind === 'content' && !result.body?.length)
        throw new OfficeInputError('正文页需要至少一个段落')
      for (const field of ['table', 'chart', 'imageId'] as const) {
        if (
          item[field] !== undefined &&
          field !== (kind === 'image' ? 'imageId' : kind)
        )
          throw new OfficeInputError(`页面类型 ${kind} 不能包含 ${field}`)
      }
      return result
    },
  )
  return {
    title,
    audience: optionalText(input.audience, '受众', 200),
    purpose: optionalText(input.purpose, '目的', 500),
    designTheme:
      input.designTheme === undefined
        ? undefined
        : validatePresentationTheme(input.designTheme),
    brand,
    slides,
  }
}
