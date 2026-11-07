import { OfficeInputError } from './types.ts'
import { textValue } from './validation.ts'
import type { OfficePresentationSlide } from './generic-presentation-plan.ts'

export interface PresentationBlock {
  id: string
  type: 'text' | 'metric' | 'image' | 'table' | 'chart' | 'shape'
  title?: string
  text?: string
  value?: string
  caption?: string
  imageId?: string
  table?: OfficePresentationSlide['table']
  chart?: OfficePresentationSlide['chart']
  shape?: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'chevron' | 'rightArrow'
  color?: string
  decorative?: boolean
  appearance?: 'plain' | 'panel' | 'accent'
  region?: { x: number; y: number; w: number; h: number }
}
export interface PresentationDesign {
  layout: 'split' | 'grid' | 'process' | 'timeline' | 'compare' | 'canvas'
  columns?: 2 | 3
  blocks: PresentationBlock[]
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OfficeInputError('页面组件必须为对象')
  return value as Record<string, unknown>
}

export function validatePresentationDesign(
  value: unknown,
  parseLegacy: (value: Record<string, unknown>) => OfficePresentationSlide,
): PresentationDesign {
  const input = record(value)
  if (
    !['split', 'grid', 'process', 'timeline', 'compare', 'canvas'].includes(
      String(input.layout),
    )
  )
    throw new OfficeInputError(
      '设计布局需为 split、grid、process、timeline、compare 或 canvas',
    )
  if (input.columns !== undefined && input.columns !== 2 && input.columns !== 3)
    throw new OfficeInputError('设计网格支持两列或三列')
  if (
    !Array.isArray(input.blocks) ||
    !input.blocks.length ||
    input.blocks.length > 16
  )
    throw new OfficeInputError('设计页需要 1–16 个内容组件')
  if (input.layout !== 'canvas' && input.blocks.length > 6)
    throw new OfficeInputError(
      '自动布局每页最多 6 个组件，请拆页或使用 canvas 区域布局',
    )
  const ids = new Set<string>()
  const blocks = input.blocks.map((raw): PresentationBlock => {
    const block = record(raw)
    const id = textValue(block.id, '组件标识', 80)
    if (ids.has(id)) throw new OfficeInputError('页面组件标识不能重复')
    ids.add(id)
    if (
      !['text', 'metric', 'image', 'table', 'chart', 'shape'].includes(
        String(block.type),
      )
    )
      throw new OfficeInputError('不支持的页面组件')
    const result: PresentationBlock = {
      id,
      type: block.type as PresentationBlock['type'],
    }
    if (block.appearance !== undefined) {
      if (!['plain', 'panel', 'accent'].includes(String(block.appearance)))
        throw new OfficeInputError('组件外观需要 plain、panel 或 accent')
      result.appearance = block.appearance as PresentationBlock['appearance']
    }
    for (const key of ['title', 'text', 'value', 'caption', 'imageId'] as const)
      if (block[key] !== undefined)
        result[key] = textValue(
          block[key],
          '组件 ' + key,
          key === 'text'
            ? 1800
            : key === 'title'
              ? 100
              : key === 'caption'
                ? 300
                : 200,
        )
    if (result.type === 'text' && !result.text)
      throw new OfficeInputError('文字组件缺少正文')
    if (result.type === 'metric' && (!result.value || result.value.length > 24))
      throw new OfficeInputError('指标组件需要不超过 24 字的明确指标值')
    if (result.type === 'image' && !result.imageId)
      throw new OfficeInputError('图片组件缺少授权图片标识')
    if (result.type === 'table' || result.type === 'chart') {
      const legacy = parseLegacy({
        id,
        kind: result.type,
        title: result.title || id,
        [result.type]: block[result.type],
      })
      result.table = legacy.table
      result.chart = legacy.chart
    }
    if (result.type === 'shape') {
      if (
        ![
          'rect',
          'roundRect',
          'ellipse',
          'line',
          'chevron',
          'rightArrow',
        ].includes(String(block.shape))
      )
        throw new OfficeInputError('原生形状不受支持')
      result.shape = block.shape as PresentationBlock['shape']
      result.decorative = block.decorative === true
    } else if (block.decorative)
      throw new OfficeInputError('只有原生装饰形状可以标注有意叠放')
    if (block.color !== undefined) {
      if (
        typeof block.color !== 'string' ||
        !/^[\da-f]{6}$/iu.test(block.color)
      )
        throw new OfficeInputError('组件颜色无效')
      result.color = block.color.toUpperCase()
    }
    if (block.region !== undefined) {
      const region = record(block.region)
      for (const key of ['x', 'y', 'w', 'h'])
        if (typeof region[key] !== 'number' || !Number.isFinite(region[key]))
          throw new OfficeInputError('组件区域必须是有限数字')
      const { x, y, w, h } = region as Record<'x' | 'y' | 'w' | 'h', number>
      if (
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        x + w > 1.00001 ||
        y + h > 1.00001
      )
        throw new OfficeInputError(
          `组件“${result.id}”区域越界：x=${x}, y=${y}, w=${w}, h=${h}。装饰形状也必须满足 x>=0、y>=0、w>0、h>0、x+w<=1、y+h<=1；区域为正文 0–1 比例。`,
        )
      result.region = { x, y, w, h }
    }
    if (input.layout === 'canvas' && !result.region)
      throw new OfficeInputError('canvas 布局需要为每个组件指定区域')
    return result
  })
  return {
    layout: input.layout as PresentationDesign['layout'],
    columns: input.columns as PresentationDesign['columns'],
    blocks,
  }
}
