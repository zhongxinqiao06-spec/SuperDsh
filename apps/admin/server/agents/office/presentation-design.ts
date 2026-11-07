import type PptxGenModule from 'pptxgenjs'
import type { PresentationRegion } from './presentation-template.ts'
import type {
  PresentationBlock,
  PresentationDesign,
} from './presentation-design-plan.ts'
import type { PresentationDesignTheme } from './design-themes.ts'
import { OfficeInputError } from './types.ts'

type NativeSlide = ReturnType<
  InstanceType<typeof PptxGenModule.default>['addSlide']
>
export type DesignCanvas = {
  [Key in 'addText' | 'addShape' | 'addChart' | 'addTable' | 'addImage']: (
    ...args: Parameters<NativeSlide[Key]>
  ) => unknown
}
type Estimate = (text: string, width: number, fontSize: number) => number
export interface DesignPlacement {
  block: PresentationBlock
  frame: PresentationRegion
  content: PresentationRegion
  title?: PresentationRegion
  fontSize: number
}

const intersect = (a: PresentationRegion, b: PresentationRegion) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.02 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.02

export function designPlacements(
  design: PresentationDesign,
  region: PresentationRegion,
  theme: PresentationDesignTheme,
  estimate: Estimate,
): DesignPlacement[] {
  const columns =
    design.columns ??
    (design.layout === 'split' || design.layout === 'compare'
      ? 2
      : design.blocks.length <= 3
        ? design.blocks.length
        : 3)
  const rows = Math.ceil(design.blocks.length / columns)
  const gap = 0.24,
    padding = 0.24
  const placements = design.blocks.map((block, index) => {
    const normalized = block.region
    const row = Math.floor(index / columns)
    const rowBlocks = design.blocks.slice(row * columns, (row + 1) * columns)
    const cellWidth = (region.w - gap * (columns - 1)) / columns
    const availableHeight = (region.h - gap * (rows - 1)) / rows
    const measuredHeight = rowBlocks.every((item) =>
      ['text', 'metric'].includes(item.type),
    )
      ? Math.max(
          2.2,
          ...rowBlocks.map(
            (item) =>
              2 * padding +
              0.25 +
              (item.title
                ? Math.max(
                    0.42,
                    estimate(
                      item.title,
                      cellWidth -
                        2 * padding -
                        (['process', 'timeline'].includes(design.layout)
                          ? 0.55
                          : 0),
                      22,
                    ),
                  )
                : 0) +
              (item.type === 'metric' ? 1.05 : 0) +
              estimate(
                [item.text, item.caption].filter(Boolean).join('\n'),
                cellWidth - 2 * padding,
                theme.density === 'compact' ? 18 : 21,
              ),
          ),
        )
      : availableHeight
    const cellHeight = Math.min(availableHeight, measuredHeight)
    const frame = normalized
      ? {
          x: region.x + normalized.x * region.w,
          y: region.y + normalized.y * region.h,
          w: normalized.w * region.w,
          h: normalized.h * region.h,
        }
      : {
          x: region.x + (index % columns) * ((region.w + gap) / columns),
          y:
            region.y +
            row * ((region.h + gap) / rows) +
            (availableHeight - cellHeight) * 0.4,
          w: cellWidth,
          h: cellHeight,
        }
    if (frame.w < 0.25 || frame.h < 0.2)
      throw new OfficeInputError(`组件“${block.title || block.id}”区域太小`)
    if (block.type === 'shape')
      return { block, frame, content: frame, fontSize: 20 }
    const numbered = design.layout === 'process' || design.layout === 'timeline'
    const titleWidth = frame.w - 2 * padding - (numbered ? 0.55 : 0)
    const titleHeight = block.title
      ? Math.max(0.42, estimate(block.title, titleWidth, 22))
      : 0
    const title: PresentationRegion | undefined = block.title
      ? {
          x: frame.x + padding + (numbered ? 0.55 : 0),
          y: frame.y + padding,
          w: frame.w - 2 * padding - (numbered ? 0.55 : 0),
          h: titleHeight,
        }
      : undefined
    if (title && (title.h > 1.15 || titleWidth <= 0))
      throw new OfficeInputError(
        `组件“${block.title}”标题过长，请缩短或扩大区域`,
      )
    const content = {
      x: frame.x + padding,
      y: frame.y + padding + titleHeight + (block.title ? 0.1 : 0),
      w: frame.w - 2 * padding,
      h: frame.h - 2 * padding - titleHeight - (block.title ? 0.1 : 0),
    }
    if (content.w < 0.1 || content.h < 0.3)
      throw new OfficeInputError(`组件“${block.title || block.id}”内容区域不足`)
    let fontSize = theme.density === 'compact' ? 18 : 21
    const text = [
      ['text', 'metric'].includes(block.type) ? block.text : undefined,
      block.caption,
    ]
      .filter(Boolean)
      .join('\n')
    if (text) {
      const available = content.h - (block.type === 'metric' ? 1.05 : 0)
      while (fontSize > 17 && estimate(text, content.w, fontSize) > available)
        fontSize--
      if (estimate(text, content.w, fontSize) > available)
        throw new OfficeInputError(
          `组件“${block.title || block.id}”正文超出版面，请缩短、拆页或扩大区域`,
        )
    }
    if (block.type === 'metric' && estimate(block.value!, content.w, 40) > 0.95)
      throw new OfficeInputError(
        `指标“${block.title || block.id}”过长，请缩短指标显示并将口径写入说明`,
      )
    return { block, frame, content, title, fontSize }
  })
  for (let index = 0; index < placements.length; index++)
    for (let other = index + 1; other < placements.length; other++) {
      const a = placements[index]!,
        b = placements[other]!
      if (
        !a.block.decorative &&
        !b.block.decorative &&
        intersect(a.frame, b.frame)
      )
        throw new OfficeInputError(
          `页面组件“${a.block.id}”与“${b.block.id}”重叠，请修正区域；装饰形状可显式标注 decorative`,
        )
    }
  return placements
}

export function renderDesign(
  canvas: DesignCanvas,
  design: PresentationDesign,
  placements: DesignPlacement[],
  theme: PresentationDesignTheme,
  renderMedia: (placement: DesignPlacement) => void,
) {
  const shape = (
    name: string,
    options: Parameters<NativeSlide['addShape']>[1],
  ) => canvas.addShape(name as Parameters<NativeSlide['addShape']>[0], options)
  if (design.layout === 'process' || design.layout === 'timeline') {
    const line = (x: number, y: number, w: number, h: number, arrow = false) =>
      shape('line', {
        x,
        y,
        w,
        h,
        line: {
          color: theme.secondary,
          width: 1.5,
          ...(arrow ? { endArrowType: 'triangle' as const } : {}),
        },
        objectName: 'design-sequence-connector',
      })
    for (let index = 1; index < placements.length; index++) {
      const previous = placements[index - 1]!.frame,
        current = placements[index]!.frame
      if (Math.abs(previous.y - current.y) < 0.05)
        line(
          previous.x + previous.w,
          previous.y + (design.layout === 'timeline' ? 0.43 : previous.h / 2),
          current.x - previous.x - previous.w,
          0,
          true,
        )
      else {
        const middle = (previous.y + previous.h + current.y) / 2
        line(
          previous.x + previous.w / 2,
          previous.y + previous.h,
          0,
          middle - previous.y - previous.h,
        )
        line(
          current.x + current.w / 2,
          middle,
          previous.x + previous.w / 2 - current.x - current.w / 2,
          0,
        )
        line(current.x + current.w / 2, middle, 0, current.y - middle, true)
      }
    }
  }
  for (const placement of [...placements].sort(
    (a, b) =>
      Number(Boolean(b.block.decorative)) - Number(Boolean(a.block.decorative)),
  )) {
    const { block, frame, content, title, fontSize } = placement
    if (block.type === 'shape') {
      shape(block.shape!, {
        ...frame,
        fill: {
          color: block.color ?? theme.accent,
          transparency: block.decorative ? 80 : 0,
        },
        line: {
          color: block.color ?? theme.accent,
          transparency: block.shape === 'line' ? 0 : 100,
        },
        objectName: 'design-shape-' + block.id,
      })
      continue
    }
    const appearance =
      block.appearance ??
      (['grid', 'compare', 'process'].includes(design.layout)
        ? 'panel'
        : 'plain')
    const foreground =
      appearance === 'accent' ? theme.background : theme.foreground
    const muted = appearance === 'accent' ? theme.background : theme.muted
    if (appearance !== 'plain')
      shape('roundRect', {
        ...frame,
        rectRadius: 0.12,
        line: { color: theme.surface, transparency: 100 },
        fill: {
          color: appearance === 'accent' ? theme.foreground : theme.surface,
        },
        objectName: 'design-card-' + block.id,
      })
    shape('rect', {
      x: frame.x + 0.24,
      y: frame.y + 0.09,
      w: 0.65,
      h: 0.045,
      line: { transparency: 100 },
      fill: { color: theme.accent },
      objectName: 'design-accent-' + block.id,
    })
    if (design.layout === 'process' || design.layout === 'timeline') {
      const index = placements.indexOf(placement)
      shape('ellipse', {
        x: frame.x + 0.23,
        y: frame.y + 0.24,
        w: 0.38,
        h: 0.38,
        line: { transparency: 100 },
        fill: { color: theme.accent },
        objectName: 'design-step-' + block.id,
      })
      canvas.addText(String(index + 1).padStart(2, '0'), {
        x: frame.x + 0.23,
        y: frame.y + 0.24,
        w: 0.38,
        h: 0.38,
        fontSize: 12,
        fontFace: theme.fontFace,
        bold: true,
        color: theme.background,
        align: 'center',
        valign: 'middle',
        margin: 0,
        objectName: 'design-step-label-' + block.id,
      })
    }
    if (title)
      canvas.addText(block.title!, {
        ...title,
        lang: 'zh-CN',
        fontFace: theme.fontFace,
        fontSize: 22,
        bold: true,
        color: foreground,
        margin: 0,
        valign: 'top',
        objectName: 'design-title-' + block.id,
      })
    if (block.type === 'text')
      canvas.addText([block.text, block.caption].filter(Boolean).join('\n\n'), {
        ...content,
        lang: 'zh-CN',
        fontFace: theme.fontFace,
        fontSize,
        color: foreground,
        margin: 0,
        valign: 'top',
        paraSpaceAfter: 10,
        objectName: 'design-text-' + block.id,
      })
    if (block.type === 'metric') {
      canvas.addText(block.value!, {
        ...content,
        h: 0.95,
        fontFace: theme.fontFace,
        fontSize: 40,
        bold: true,
        color: block.color ?? theme.accent,
        margin: 0,
        valign: 'middle',
        objectName: 'design-metric-' + block.id,
      })
      const detail = [block.text, block.caption].filter(Boolean).join('\n')
      if (detail)
        canvas.addText(detail, {
          ...content,
          y: content.y + 1.05,
          lang: 'zh-CN',
          h: content.h - 1.05,
          fontFace: theme.fontFace,
          fontSize,
          color: muted,
          margin: 0,
          valign: 'top',
          objectName: 'design-caption-' + block.id,
        })
    }
    if (['image', 'table', 'chart'].includes(block.type)) {
      renderMedia(
        block.caption
          ? { ...placement, content: { ...content, h: content.h - 0.6 } }
          : placement,
      )
      if (block.caption)
        canvas.addText(block.caption, {
          x: content.x,
          y: content.y + content.h - 0.48,
          w: content.w,
          h: 0.48,
          fontFace: theme.fontFace,
          fontSize: 15,
          color: muted,
          margin: 0,
          valign: 'top',
          objectName: 'design-source-' + block.id,
        })
    }
  }
}

export function renderBrandFrame(
  canvas: DesignCanvas,
  theme: PresentationDesignTheme,
  width: number,
  height: number,
  company: string,
  page: number,
  count: number,
  cover: boolean,
) {
  const shape = (
    name: string,
    options: Parameters<NativeSlide['addShape']>[1],
  ) => canvas.addShape(name as Parameters<NativeSlide['addShape']>[0], options)
  shape('rect', {
    x: 0.65,
    y: cover ? 1.2 : 0.27,
    w: cover ? 1.1 : 0.6,
    h: 0.07,
    line: { transparency: 100 },
    fill: { color: theme.accent },
    objectName: 'brand-accent',
  })
  if (cover) {
    shape('ellipse', {
      x: width - 3.6,
      y: height - 3.1,
      w: 2.7,
      h: 2.7,
      line: { color: theme.accent, width: 2, transparency: 50 },
      fill: { color: theme.background, transparency: 100 },
      objectName: 'brand-decoration-outer',
    })
    shape('ellipse', {
      x: width - 3.1,
      y: height - 2.6,
      w: 1.7,
      h: 1.7,
      line: { color: theme.secondary, width: 1.5, transparency: 50 },
      fill: { color: theme.background, transparency: 100 },
      objectName: 'brand-decoration-inner',
    })
  }
  canvas.addText(company || 'SUPERDSH', {
    x: 0.65,
    y: height - 0.4,
    w: width - 2.6,
    h: 0.18,
    fontFace: theme.fontFace,
    fontSize: 9,
    charSpacing: 1,
    color: theme.muted,
    margin: 0,
    objectName: 'brand-footer',
  })
  canvas.addText(
    String(page).padStart(2, '0') + ' / ' + String(count).padStart(2, '0'),
    {
      x: width - 1.65,
      y: height - 0.4,
      w: 1,
      h: 0.18,
      fontFace: theme.fontFace,
      fontSize: 9,
      color: theme.muted,
      margin: 0,
      align: 'right',
      objectName: 'brand-page',
    },
  )
}
