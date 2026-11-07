import { imageData } from './image-data.ts'
import { Automizer, modify } from 'pptx-automizer'
import PptxGenModule from 'pptxgenjs'
import { XMLSerializer } from '@xmldom/xmldom'
import type JSZip from 'jszip'
import {
  validateOfficePresentationPlan,
  type OfficePresentationPlan,
  type OfficePresentationSlide,
  type PresentationDiagnostic,
} from './generic-presentation-plan.ts'
import {
  inspectOfficePresentationTemplate,
  type PresentationRegion,
  type PresentationTemplateShape,
  type PresentationTemplateSlide,
} from './presentation-template.ts'
import {
  OfficeInputError,
  type OfficeArtifact,
  type OfficeInputFile,
} from './types.ts'
import { PPTX_MEDIA_TYPE } from './presentation.ts'
import { parseXml } from './validation.ts'
import {
  designPlacements,
  renderDesign,
  renderBrandFrame,
  type DesignCanvas,
} from './presentation-design.ts'
import { presentationThemes } from './design-themes.ts'
import { documentFont, measuredTextHeight } from './font-metrics.ts'

export { validateOfficePresentationPlan, inspectOfficePresentationTemplate }
export type {
  OfficePresentationPlan,
  OfficePresentationSlide,
  PresentationDiagnostic,
}

const PptxGenJS = PptxGenModule as unknown as typeof PptxGenModule.default
type SlideCanvas = DesignCanvas

export interface OfficePresentationInput {
  plan: OfficePresentationPlan
  template?: OfficeInputFile
  images?: { id: string; file: OfficeInputFile }[]
  sources?: { id: string; filename: string; text: string }[]
  signal?: AbortSignal
}

export interface OfficePresentationArtifact extends OfficeArtifact {
  diagnostics: PresentationDiagnostic[]
  pages: { id: string; number: number; title: string; sourceIds: string[] }[]
}

interface SlideLayout {
  title: PresentationRegion
  body: PresentationRegion
  titleFont: number
  bodyFont: number
  titleShape?: PresentationTemplateShape
  bodyShape?: PresentationTemplateShape
  templateSlide?: PresentationTemplateSlide
}

function within(region: PresentationRegion, width: number, height: number) {
  return (
    [region.x, region.y, region.w, region.h].every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.w > 0 &&
    region.h > 0 &&
    region.x + region.w <= width + 0.02 &&
    region.y + region.h <= height + 0.02
  )
}

function overlaps(a: PresentationRegion, b: PresentationRegion) {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.03 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.03
  )
}

/** Conservative line estimate. Rendering remains the final visual check. */
export function estimatePresentationTextHeight(
  text: string,
  width: number,
  fontSize: number,
) {
  const measured = measuredTextHeight(text, width, fontSize)
  if (measured !== undefined) return measured
  const unitsPerLine = Math.max(1, (width * 72) / fontSize)
  return (
    (text.split('\n').reduce((lines, paragraph) => {
      const units = Array.from(paragraph).reduce(
        (sum, character) =>
          sum +
          (/[^\u0000-\u024f]/u.test(character)
            ? 1
            : /[A-ZMW@]/u.test(character)
              ? 0.72
              : 0.56),
        0,
      )
      return lines + Math.max(1, Math.ceil(units / unitsPerLine))
    }, 0) *
      fontSize *
      1.35) /
    72
  )
}

function assertTextFits(
  text: string,
  region: PresentationRegion,
  fontSize: number,
  label: string,
) {
  if (
    estimatePresentationTextHeight(text, region.w - 0.08, fontSize) >
    region.h + 0.02
  )
    throw new OfficeInputError(
      `${label}超出可读版面，请缩短文字、拆页或扩大模板区域`,
    )
}

function layoutFor(
  slide: OfficePresentationSlide,
  width: number,
  height: number,
  template?: Awaited<ReturnType<typeof inspectOfficePresentationTemplate>>,
): SlideLayout {
  if (!template) {
    if (slide.template)
      throw new OfficeInputError('方案指定了模板映射，但未提供模板')
    const cover = slide.kind === 'title'
    return {
      title: {
        x: 0.65,
        y: cover ? 1.65 : 0.55,
        w: width - 1.3,
        h: cover ? 1.4 : 0.9,
      },
      body: {
        x: 0.65,
        y: cover ? 3.3 : 1.7,
        w: width - 1.3,
        h: cover ? height - 4.25 : height - 2.45,
      },
      titleFont: cover ? 42 : 32,
      bodyFont: 20,
    }
  }
  if (!slide.template)
    throw new OfficeInputError(
      `页面“${slide.title}”需要先确认模板页及内容区域映射`,
    )
  const templateSlide = template.slides[slide.template.slide - 1]
  if (!templateSlide)
    throw new OfficeInputError(`模板不存在第 ${slide.template.slide} 页`)
  const textShapes = templateSlide.shapes.filter((shape) => shape.region)
  const select = (name: string | undefined) =>
    name ? templateSlide.shapes.find((shape) => shape.name === name) : undefined
  const titleShape = slide.template.titleShape
    ? select(slide.template.titleShape)
    : (textShapes.find(
        (shape) => shape.role === 'title' || shape.role === 'ctrTitle',
      ) ?? [...textShapes].sort((a, b) => a.region!.y - b.region!.y)[0])
  const bodyShape = slide.template.bodyShape
    ? select(slide.template.bodyShape)
    : textShapes
        .filter((shape) => shape !== titleShape && shape.region!.h > 0.65)
        .sort(
          (a, b) => b.region!.w * b.region!.h - a.region!.w * a.region!.h,
        )[0]
  if (!titleShape?.region || (slide.template.bodyShape && !bodyShape?.region))
    throw new OfficeInputError(
      `模板第 ${slide.template.slide} 页未找到有明确尺寸的映射文本框`,
    )
  const body = slide.template.contentRegion ?? bodyShape?.region
  if (!body) throw new OfficeInputError('模板需指定正文文本框或内容区域')
  if (titleShape === bodyShape)
    throw new OfficeInputError('模板标题和正文不能映射到同一个文本框')
  for (const shape of templateSlide.shapes) {
    if (
      shape !== titleShape &&
      shape !== bodyShape &&
      shape.text.trim() &&
      shape.region &&
      overlaps(body, shape.region)
    )
      throw new OfficeInputError(
        `模板内容区域与“${shape.name}”重叠，请调整映射区域`,
      )
  }
  for (const object of templateSlide.objects) {
    if (
      object.region &&
      object.region.w * object.region.h < width * height * 0.8 &&
      overlaps(body, object.region)
    )
      throw new OfficeInputError(
        `模板内容区域与图片或图表“${object.name}”重叠，请调整映射区域`,
      )
  }
  return {
    title: titleShape.region,
    body,
    titleFont: titleShape.fontSize ?? 32,
    bodyFont: bodyShape?.fontSize ?? 20,
    titleShape,
    bodyShape,
    templateSlide,
  }
}

function contentRegion(slide: OfficePresentationSlide, layout: SlideLayout) {
  const hasCaption =
    slide.kind !== 'title' && slide.kind !== 'content' && slide.body?.length
  if (!hasCaption) return layout.body
  const caption = slide.body!.join('\n')
  const height =
    estimatePresentationTextHeight(caption, layout.body.w, layout.bodyFont) +
    0.2
  if (height > layout.body.h * 0.35)
    throw new OfficeInputError(`页面“${slide.title}”的说明过长，请移到单独页面`)
  return {
    ...layout.body,
    y: layout.body.y + height,
    h: layout.body.h - height,
  }
}

function renderContent(
  canvas: SlideCanvas,
  slide: OfficePresentationSlide,
  layout: SlideLayout,
  plan: OfficePresentationPlan,
  images: Map<string, ReturnType<typeof imageData>>,
  title = true,
) {
  const fontFace =
    plan.brand?.fontFace ?? layout.bodyShape?.fontFace ?? 'Microsoft YaHei'
  const color = plan.brand?.textColor ?? '243746'
  if (title)
    canvas.addText(slide.title, {
      ...layout.title,
      fontSize: layout.titleFont,
      bold: true,
      fontFace,
      color: plan.brand?.accentColor ?? '183B56',
      margin: 0,
      valign: 'middle',
      objectName: `office-${slide.id}-title`,
    })
  const region = contentRegion(slide, layout)
  if (slide.design) {
    const theme = plan.designTheme ?? presentationThemes[0]!
    const placements = designPlacements(
      slide.design,
      layout.body,
      theme,
      estimatePresentationTextHeight,
    )
    renderDesign(canvas, slide.design, placements, theme, (placement) =>
      renderContent(
        canvas,
        {
          id: slide.id + '-' + placement.block.id,
          title: placement.block.title || slide.title,
          kind: placement.block.type as 'image' | 'table' | 'chart',
          imageId: placement.block.imageId,
          table: placement.block.table,
          chart: placement.block.chart,
        },
        { ...layout, body: placement.content },
        plan,
        images,
        false,
      ),
    )
    return
  }
  if (slide.body?.length)
    canvas.addText(slide.body.join('\n'), {
      ...layout.body,
      h:
        region.y > layout.body.y
          ? region.y - layout.body.y - 0.2
          : layout.body.h,
      fontSize: layout.bodyFont,
      fontFace,
      color,
      margin: 0,
      valign: 'top',
      breakLine: false,
      paraSpaceAfter: 8,
      objectName: `office-${slide.id}-body`,
    })
  if (slide.table) {
    const rows = [slide.table.columns, ...slide.table.rows].map((row, index) =>
      row.map((value) => ({
        text: String(value),
        options:
          index === 0
            ? {
                bold: true,
                color: 'FFFFFF',
                fill: { color: plan.brand?.accentColor ?? '183B56' },
              }
            : {},
      })),
    )
    canvas.addTable(rows, {
      ...region,
      fontFace,
      fontSize: 17,
      color,
      margin: 5,
      border: { type: 'solid', pt: 0.5, color: 'CDD7E0' },
      rowH: region.h / rows.length,
      valign: 'middle',
      autoPage: false,
      objectName: `office-${slide.id}-table`,
    })
  }
  if (slide.chart)
    canvas.addChart(
      slide.chart.type,
      slide.chart.series.map((series) => ({
        name: series.name,
        labels: slide.chart!.categories,
        values: series.values,
      })),
      {
        ...region,
        catAxisLabelFontFace: fontFace,
        valAxisLabelFontFace: fontFace,
        catAxisLabelFontSize: 14,
        valAxisLabelFontSize: 14,
        showLegend: slide.chart.series.length > 1,
        legendFontFace: fontFace,
        legendFontSize: 14,
        showValue: slide.chart.type === 'pie',
        showTitle: false,
        showLabel: slide.chart.type === 'pie',
        showPercent: slide.chart.type === 'pie',
        valAxisTitle: slide.chart.valueUnit ?? '',
        showValAxisTitle: Boolean(slide.chart.valueUnit),
        chartColors: [
          plan.brand?.accentColor ?? '183B56',
          '188A9A',
          'E9A23B',
          '796AC0',
          '589A6E',
          'CE6B57',
        ],
        objectName: `office-${slide.id}-chart`,
      },
    )
  if (slide.imageId) {
    const image = images.get(slide.imageId)!
    const scale = Math.min(region.w / image.width, region.h / image.height)
    const w = image.width * scale
    const h = image.height * scale
    canvas.addImage({
      data: image.data,
      x: region.x + (region.w - w) / 2,
      y: region.y + (region.h - h) / 2,
      w,
      h,
      altText: slide.title,
      objectName: `office-${slide.id}-image`,
    })
  }
}

function xmlText(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

async function writeNotes(archive: JSZip, notes: string[]) {
  const serializer = new XMLSerializer()
  const contentTypes = parseXml(
    await archive.file('[Content_Types].xml')!.async('string'),
  )
  for (const [index, note] of notes.entries()) {
    if (!note) continue
    const slide = index + 1
    const relPath = `ppt/slides/_rels/slide${slide}.xml.rels`
    const relations = parseXml(await archive.file(relPath)!.async('string'))
    let existing = Array.from(
      relations.getElementsByTagNameNS('*', 'Relationship'),
    ).find((item) => item.getAttribute('Type')?.endsWith('/notesSlide'))
    const notePath = `ppt/notesSlides/office-notes-${slide}.xml`
    if (!existing) {
      existing = relations.createElementNS(
        relations.documentElement!.namespaceURI,
        'Relationship',
      )
      existing.setAttribute('Id', `rIdOfficeNotes${slide}`)
      existing.setAttribute(
        'Type',
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
      )
      relations.documentElement!.appendChild(existing)
    }
    existing.setAttribute('Target', `../notesSlides/office-notes-${slide}.xml`)
    archive.file(relPath, serializer.serializeToString(relations))
    archive.file(
      notePath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${note
        .split('\n')
        .map((line) => `<a:p><a:r><a:t>${xmlText(line)}</a:t></a:r></a:p>`)
        .join(
          '',
        )}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
    )
    archive.file(
      `ppt/notesSlides/_rels/office-notes-${slide}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slide}.xml"/></Relationships>`,
    )
    const override = contentTypes.createElementNS(
      contentTypes.documentElement!.namespaceURI,
      'Override',
    )
    override.setAttribute('PartName', `/${notePath}`)
    override.setAttribute(
      'ContentType',
      'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
    )
    contentTypes.documentElement!.appendChild(override)
  }
  archive.file(
    '[Content_Types].xml',
    serializer.serializeToString(contentTypes),
  )
}

export async function generateOfficePresentation(
  input: OfficePresentationInput,
): Promise<OfficePresentationArtifact> {
  input.signal?.throwIfAborted()
  const plan = validateOfficePresentationPlan(input.plan)
  const template = input.template
    ? await inspectOfficePresentationTemplate(input.template)
    : undefined
  if (!template || plan.designTheme) {
    plan.designTheme ??= { ...presentationThemes[0]! }
    plan.brand = {
      ...plan.brand,
      fontFace: plan.brand?.fontFace ?? plan.designTheme.fontFace,
      accentColor: plan.brand?.accentColor ?? plan.designTheme.accent,
      textColor: plan.brand?.textColor ?? plan.designTheme.foreground,
      backgroundColor:
        plan.brand?.backgroundColor ?? plan.designTheme.background,
    }
    plan.designTheme = {
      ...plan.designTheme,
      fontFace: plan.brand.fontFace!,
      accent: plan.brand.accentColor!,
      foreground: plan.brand.textColor!,
      background: plan.brand.backgroundColor!,
    }
  }
  const width = template?.width ?? 13.333333
  const height = template?.height ?? 7.5
  const diagnostics: PresentationDiagnostic[] = []
  if (!documentFont())
    diagnostics.push({
      severity: 'warning',
      code: 'font-metrics-unavailable',
      message:
        '统一字体资源未准备，排版仅采用保守估算；请运行 server:sync 准备字体并检查实际预览。',
    })
  const sources = new Map(
    (input.sources ?? []).map((source) => [source.id, source]),
  )
  if (sources.size !== (input.sources?.length ?? 0))
    throw new OfficeInputError('资料来源标识不能重复')
  const images = new Map<string, ReturnType<typeof imageData>>()
  for (const image of input.images ?? []) {
    if (images.has(image.id)) throw new OfficeInputError('图片标识不能重复')
    images.set(image.id, imageData(image.file))
  }
  const notes: string[] = []
  const layouts = plan.slides.map((slide) => {
    const layout = layoutFor(slide, width, height, template)
    if (
      !within(layout.title, width, height) ||
      !within(layout.body, width, height) ||
      overlaps(layout.title, layout.body)
    )
      throw new OfficeInputError(
        `页面“${slide.title}”的标题与正文区域越界或重叠`,
      )
    assertTextFits(
      slide.title,
      layout.title,
      layout.titleFont,
      `页面“${slide.title}”标题`,
    )
    if (slide.body?.length)
      assertTextFits(
        slide.body.join('\n'),
        layout.body,
        layout.bodyFont,
        `页面“${slide.title}”正文`,
      )
    const region = contentRegion(slide, layout)
    if (slide.table) {
      const rowHeight = region.h / (slide.table.rows.length + 1)
      for (const row of [slide.table.columns, ...slide.table.rows])
        for (const cell of row)
          assertTextFits(
            String(cell),
            {
              x: 0,
              y: 0,
              w: region.w / slide.table.columns.length - 0.12,
              h: rowHeight - 0.12,
            },
            17,
            `页面“${slide.title}”表格单元格`,
          )
    }
    if (slide.chart && slide.chart.type !== 'pie') {
      const labelWidth = Math.max(
        0.1,
        (region.w - 0.8) / slide.chart.categories.length,
      )
      for (const label of slide.chart.categories)
        assertTextFits(
          label,
          { x: 0, y: 0, w: labelWidth, h: 0.75 },
          14,
          `页面“${slide.title}”图表分类标签`,
        )
    }
    if (slide.imageId && !images.has(slide.imageId))
      throw new OfficeInputError(`缺少已授权图片：${slide.imageId}`)
    if (slide.design) {
      const placements = designPlacements(
        slide.design,
        layout.body,
        plan.designTheme ?? presentationThemes[0]!,
        estimatePresentationTextHeight,
      )
      for (const { block, content } of placements) {
        if (block.imageId && !images.has(block.imageId))
          throw new OfficeInputError(`缺少已授权图片：${block.imageId}`)
        if (block.table) {
          const rowHeight =
            (content.h - (block.caption ? 0.6 : 0)) /
            (block.table.rows.length + 1)
          for (const row of [block.table.columns, ...block.table.rows])
            for (const cell of row)
              assertTextFits(
                String(cell),
                {
                  x: 0,
                  y: 0,
                  w: content.w / block.table.columns.length - 0.12,
                  h: rowHeight - 0.12,
                },
                17,
                `组件“${block.title || block.id}”表格单元格`,
              )
        }
        if (block.chart && block.chart.type !== 'pie')
          for (const label of block.chart.categories)
            assertTextFits(
              label,
              {
                x: 0,
                y: 0,
                w: Math.max(
                  0.1,
                  (content.w - 0.8) / block.chart.categories.length,
                ),
                h: 0.75,
              },
              14,
              `组件“${block.title || block.id}”图表标签`,
            )
      }
    }
    const references = (slide.sourceIds ?? []).map((id) => {
      const source = sources.get(id)
      if (!source)
        throw new OfficeInputError(
          `页面“${slide.title}”引用了未授权资料：${id}`,
        )
      return `资料：${source.filename}（${id}）`
    })
    notes.push([slide.notes ?? '', ...references].filter(Boolean).join('\n'))
    if (layout.titleFont < 24 || layout.bodyFont < 17)
      diagnostics.push({
        severity: 'warning',
        code: 'template_small_font',
        slideId: slide.id,
        message: '保留模板的小号字体，请在预览中确认可读性',
      })
    return layout
  })
  input.signal?.throwIfAborted()
  let content: Buffer
  if (template && input.template) {
    const automizer = new Automizer({
      removeExistingSlides: true,
      cleanup: true,
      verbosity: 0,
    })
      .loadRoot(input.template.content)
      .load(input.template.content, 'company-template')
    for (const [index, slide] of plan.slides.entries()) {
      const layout = layouts[index]!
      automizer.addSlide(
        'company-template',
        layout.templateSlide!.partNumber,
        (output) => {
          input.signal?.throwIfAborted()
          output.modifyElement(
            layout.titleShape!.name,
            modify.setText(slide.title),
          )
          if (layout.bodyShape) output.removeElement(layout.bodyShape.name)
          output.generate((canvas) =>
            renderContent(canvas, slide, layout, plan, images, false),
          )
        },
      )
    }
    const archive = await automizer.getJSZip()
    await writeNotes(archive, notes)
    content = await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    })
  } else {
    const presentation = new PptxGenJS()
    presentation.layout = 'LAYOUT_WIDE'
    presentation.author = 'SuperDsh'
    presentation.title = plan.title
    presentation.subject = plan.purpose ?? ''
    presentation.company = plan.brand?.company ?? ''
    presentation.theme = {
      headFontFace: plan.brand?.fontFace ?? 'Microsoft YaHei',
      bodyFontFace: plan.brand?.fontFace ?? 'Microsoft YaHei',
    }
    for (const [index, item] of plan.slides.entries()) {
      input.signal?.throwIfAborted()
      const slide = presentation.addSlide()
      slide.background = { color: plan.brand?.backgroundColor ?? 'FFFFFF' }
      renderBrandFrame(
        slide,
        plan.designTheme ?? presentationThemes[0]!,
        width,
        height,
        plan.brand?.company ?? '',
        index + 1,
        plan.slides.length,
        item.kind === 'title',
      )
      renderContent(slide, item, layouts[index]!, plan, images)
      if (notes[index]) slide.addNotes(notes[index]!)
    }
    content = Buffer.from(
      (await presentation.write({
        outputType: 'nodebuffer',
        compression: true,
      })) as Buffer,
    )
  }
  input.signal?.throwIfAborted()
  diagnostics.push({
    severity: 'info',
    code: 'visual_review_required',
    message: '已检查元素边界和文本容量；请逐页预览确认字体替换及模板视觉效果',
  })
  return {
    filename: `${plan.title.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '_').slice(0, 100)}.pptx`,
    mediaType: PPTX_MEDIA_TYPE,
    content,
    diagnostics,
    pages: plan.slides.map((slide, index) => ({
      id: slide.id,
      number: index + 1,
      title: slide.title,
      sourceIds: slide.sourceIds ?? [],
    })),
  }
}
