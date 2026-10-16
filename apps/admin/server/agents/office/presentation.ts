import { Automizer, modify } from 'pptx-automizer'
import PptxGenModule from 'pptxgenjs'
import { parseSalesFile, summarizeSales } from './sales.ts'
import {
  OfficeInputError,
  type KnowledgeText,
  type OfficeArtifact,
  type OfficeInputFile,
  type SalesReportInput,
} from './types.ts'
import {
  OFFICE_LIMITS,
  parseXml,
  readOfficeArchive,
  textValue,
} from './validation.ts'

export const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const presentationPlaceholders = [
  'title',
  'company',
  'period',
  'summary',
  'source',
  'orderCount',
  'units',
  'revenue',
  'cost',
  'profit',
  'grossMargin',
  'regionSummary',
  'productSummary',
  'knowledge',
]
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const presentationNamespace =
  'http://schemas.openxmlformats.org/presentationml/2006/main'

export async function inspectPresentationTemplate(file: OfficeInputFile) {
  const archive = readOfficeArchive(file)
  if (!archive.file('ppt/presentation.xml'))
    throw new OfficeInputError('文件不是 PPTX 演示文稿')
  const parts = archive
    .file(/^ppt\/slides\/slide\d+\.xml$/u)
    .sort(
      (a, b) =>
        Number(a.name.match(/slide(\d+)/u)?.[1]) -
        Number(b.name.match(/slide(\d+)/u)?.[1]),
    )
  if (parts.length < 1 || parts.length > OFFICE_LIMITS.slides)
    throw new OfficeInputError('PPT 模板需为 1–20 页')
  const presentation = parseXml(
    await archive.file('ppt/presentation.xml')!.async('string'),
  )
  const relations = archive.file('ppt/_rels/presentation.xml.rels')
  if (!relations) throw new OfficeInputError('PPT 模板缺少页面关系')
  const relationMap = new Map(
    Array.from(
      parseXml(await relations.async('string')).getElementsByTagNameNS(
        '*',
        'Relationship',
      ),
    ).map((item) => [item.getAttribute('Id'), item.getAttribute('Target')]),
  )
  const pageIds = Array.from(
    presentation.getElementsByTagNameNS(presentationNamespace, 'sldId'),
  )
  if (
    pageIds.length !== parts.length ||
    pageIds.some(
      (item, index) =>
        relationMap.get(item.getAttribute('r:id')) !==
        `slides/slide${index + 1}.xml`,
    )
  ) {
    throw new OfficeInputError(
      '演示版模板要求连续页面顺序，请另存为新的 PPTX 后上传',
    )
  }
  const placeholders = new Set<string>()
  const slides: { number: number; shapes: { name: string; text: string }[] }[] =
    []
  for (const [index, part] of parts.entries()) {
    if (part.name !== `ppt/slides/slide${index + 1}.xml`)
      throw new OfficeInputError('PPT 模板页编号不连续，请另存为新的 PPTX')
    const document = parseXml(await part.async('string'))
    if (
      document.getElementsByTagNameNS(presentationNamespace, 'timing').length ||
      document.getElementsByTagNameNS(drawingNamespace, 'videoFile').length ||
      document.getElementsByTagNameNS(drawingNamespace, 'audioFile').length
    ) {
      throw new OfficeInputError(
        '演示版模板不支持动画、音视频，请移除后重新上传',
      )
    }
    const shapes: { name: string; text: string }[] = []
    const names = Array.from(
      document.getElementsByTagNameNS(presentationNamespace, 'cNvPr'),
    ).map((item) => item.getAttribute('name'))
    for (const shape of Array.from(
      document.getElementsByTagNameNS(presentationNamespace, 'sp'),
    )) {
      const text = Array.from(
        shape.getElementsByTagNameNS(drawingNamespace, 'p'),
      )
        .map((paragraph) =>
          Array.from(paragraph.getElementsByTagNameNS(drawingNamespace, 't'))
            .map((node) => node.textContent)
            .join(''),
        )
        .join('\n')
      const tokens = Array.from(
        text.matchAll(/\{\{([^{}]+)\}\}/gu),
        (match) => match[1]!,
      )
      if (text.replace(/\{\{[^{}]+\}\}/gu, '').match(/\{\{|\}\}/u))
        throw new OfficeInputError('PPT 模板占位符未闭合')
      if (!tokens.length) continue
      const name = shape
        .getElementsByTagNameNS(presentationNamespace, 'cNvPr')[0]
        ?.getAttribute('name')
      if (!name || names.filter((item) => item === name).length !== 1)
        throw new OfficeInputError('含占位符的文本框必须有唯一名称')
      for (const token of tokens) {
        if (!presentationPlaceholders.includes(token))
          throw new OfficeInputError(`不支持的 PPT 占位符：{{${token}}}`)
        placeholders.add(token)
      }
      shapes.push({ name, text })
    }
    for (const table of Array.from(
      document.getElementsByTagNameNS(drawingNamespace, 'tbl'),
    )) {
      if (/\{\{|\}\}/u.test(table.textContent ?? ''))
        throw new OfficeInputError(
          'PPT 占位符请放在普通文本框中，暂不支持表格占位符',
        )
    }
    slides.push({ number: index + 1, shapes })
  }
  for (const key of ['title', 'revenue']) {
    if (!placeholders.has(key))
      throw new OfficeInputError(
        `PPT 模板缺少 {{${key}}}，请使用带占位符的企业模板`,
      )
  }
  return { archive, slides, placeholders: [...placeholders] }
}

export async function createSalesPresentationTemplate(): Promise<OfficeArtifact> {
  // 4.x ships CommonJS declarations for its ESM constructor export.
  const PptxGenJS = PptxGenModule as unknown as typeof PptxGenModule.default
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  presentation.author = 'SuperDsh'
  presentation.subject = '受控销售报告模板'
  presentation.title = '销售经营报告模板'
  presentation.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
  }
  const addSlide = (
    title: string,
    body: string,
    footer = '{{company}} · {{period}}',
  ) => {
    const slide = presentation.addSlide()
    slide.background = { color: 'F8FAFC' }
    slide.addText(title, {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.8,
      fontSize: 30,
      bold: true,
      color: '183B56',
      breakLine: false,
      objectName: 'report-title',
      margin: 0,
    })
    slide.addText(body, {
      x: 0.7,
      y: 1.7,
      w: 11.9,
      h: 4.5,
      fontSize: 21,
      color: '243746',
      valign: 'top',
      paraSpaceAfter: 16,
      objectName: 'report-body',
      margin: 0,
    })
    slide.addText(footer, {
      x: 0.7,
      y: 6.7,
      w: 11.9,
      h: 0.35,
      fontSize: 11,
      color: '66788A',
      objectName: 'report-footer',
      margin: 0,
    })
  }
  addSlide('{{title}}', '{{company}}\n{{period}}\n数据来源：{{source}}')
  addSlide(
    '经营数据',
    '销售额：{{revenue}} 元\n成本：{{cost}} 元\n毛利：{{profit}} 元\n毛利率：{{grossMargin}}\n订单数：{{orderCount}}　销售件数：{{units}}',
  )
  addSlide('区域销售表现', '{{regionSummary}}')
  addSlide('产品销售表现', '{{productSummary}}')
  addSlide('资料依据与业务建议', '{{knowledge}}\n\n业务建议：{{summary}}')
  const output = await presentation.write({ outputType: 'nodebuffer' })
  return {
    filename: '销售汇报模板.pptx',
    mediaType: PPTX_MEDIA_TYPE,
    content: Buffer.from(output as Buffer),
  }
}

function qualitativeAdvice(value: string | undefined) {
  const advice = textValue(
    value ?? '结合区域和产品明细复核库存安排，确认异常订单后再制定行动计划。',
    '业务建议',
    180,
  )
  if (
    /\d|[%％￥$]|百分之|[零〇一二两三四五六七八九十百千万亿]+(?:元|倍|个百分点)/u.test(
      advice,
    )
  ) {
    throw new OfficeInputError(
      '业务建议只接受定性文字；金额、数量、比例由销售数据自动计算',
    )
  }
  return advice
}

export async function generateSalesPresentation(
  input: SalesReportInput & {
    summary?: string
    knowledge?: KnowledgeText[]
  },
): Promise<OfficeArtifact> {
  const rows = await parseSalesFile(input.data)
  const summary = summarizeSales(rows)
  const template = input.template ?? (await createSalesPresentationTemplate())
  const { slides } = await inspectPresentationTemplate(template)
  const money = (value: number) =>
    value.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  const describe = (groups: typeof summary.regions) =>
    groups
      .slice(0, 5)
      .map(
        (group) =>
          `${group.name}：销售额 ${money(group.revenue)} 元，毛利 ${money(group.profit)} 元`,
      )
      .join('\n') +
    (groups.length > 5
      ? `\n仅展示前五项，共 ${groups.length} 项，完整记录见 Excel 明细。`
      : '')
  if (input.knowledge && input.knowledge.length > 3)
    throw new OfficeInputError('报告最多引用三份公司资料')
  const references =
    input.knowledge?.map((source) => {
      const filename = textValue(source.filename, '资料来源名称', 200)
      const text = textValue(
        source.text,
        '资料正文',
        OFFICE_LIMITS.textCharacters,
      )
      return `${filename}：${text.replace(/\s+/gu, ' ').slice(0, 90)}${text.length > 90 ? '…' : ''}`
    }) ?? []
  const fields: Record<string, string> = {
    title: textValue(input.title ?? '销售经营报告', '报告标题', 60),
    company: textValue(input.companyName ?? '公司', '公司名称', 60),
    summary: qualitativeAdvice(input.summary),
    period: `${summary.periodStart} 至 ${summary.periodEnd}`,
    source: input.data.filename,
    orderCount: String(summary.orderCount),
    units: String(summary.units),
    revenue: money(summary.revenue),
    cost: money(summary.cost),
    profit: money(summary.profit),
    grossMargin:
      summary.grossMargin === null
        ? '不适用（销售额为零）'
        : `${(summary.grossMargin * 100).toFixed(1)}%`,
    regionSummary: describe(summary.regions),
    productSummary: describe(summary.products),
    knowledge: references.length
      ? `资料摘录（原文）：\n${references.join('\n')}`
      : '未提供公司资料，本报告仅依据上传的销售数据。',
  }
  const automizer = new Automizer({
    removeExistingSlides: true,
    cleanup: true,
    verbosity: 0,
  })
    .loadRoot(template.content)
    .load(template.content, 'uploaded-template')
  for (const slide of slides) {
    automizer.addSlide('uploaded-template', slide.number, (output) => {
      for (const shape of slide.shapes) {
        const text = shape.text.replace(
          /\{\{([^{}]+)\}\}/gu,
          (_, name: string) => fields[name]!,
        )
        if (text.length > 1000)
          throw new OfficeInputError('模板文本框内容过长，请减少资料或拆分版面')
        output.modifyElement(shape.name, modify.setText(text))
      }
    })
  }
  const archive = await automizer.getJSZip()
  const content = await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  })
  return {
    filename: '销售经营报告.pptx',
    mediaType: PPTX_MEDIA_TYPE,
    content,
    summary,
  }
}
