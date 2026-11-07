import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type FileChild,
} from 'docx'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import {
  validateOfficeDocumentPlan,
  type OfficeDocumentPlan,
} from './document-plan.ts'
import {
  applyDocumentTemplate,
  inspectDocumentTemplate,
} from './document-template.ts'
import { imageData } from './image-data.ts'

export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export { validateOfficeDocumentPlan, inspectDocumentTemplate }

export interface OfficeDocumentInput {
  plan: OfficeDocumentPlan
  template?: OfficeInputFile
  sources?: { id: string; filename: string; text: string }[]
  images?: { id: string; file: OfficeInputFile }[]
}

export async function generateOfficeDocument(input: OfficeDocumentInput) {
  const plan = validateOfficeDocumentPlan(input.plan)
  const template = input.template
    ? await inspectDocumentTemplate(input.template)
    : undefined
  const font = plan.brand.fontFace ?? template?.fontFace ?? 'Noto Sans CJK SC'
  const accent = plan.brand.accentColor
  const images = new Map(
    (input.images ?? []).map((item) => [item.id, item.file]),
  )
  const sources = new Map((input.sources ?? []).map((item) => [item.id, item]))
  const citations = new Map<string, number>()
  const diagnostics: {
    severity: 'info' | 'warning'
    code: string
    message: string
  }[] = []
  const children: FileChild[] = []
  const paragraph = (
    text: string,
    options: ConstructorParameters<typeof Paragraph>[0] = {},
  ) =>
    new Paragraph({
      ...(typeof options === 'string' ? {} : options),
      children: [new TextRun({ text, font })],
    })
  children.push(
    new Paragraph({
      spacing: { before: 1200, after: 320 },
      children: [
        new TextRun({
          text: plan.brand.company || '文档方案',
          font,
          size: 22,
          color: accent,
          bold: true,
        }),
      ],
    }),
  )
  children.push(
    new Paragraph({
      spacing: { after: 340 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          color: accent,
          size: 18,
          space: 20,
        },
      },
      children: [
        new TextRun({
          text: plan.title,
          font,
          size: 48,
          bold: true,
          color: '183344',
        }),
      ],
    }),
  )
  if (plan.subtitle)
    children.push(paragraph(plan.subtitle, { spacing: { after: 260 } }))
  if (plan.purpose)
    children.push(
      paragraph(plan.purpose, { spacing: { before: 340, after: 240 } }),
    )
  children.push(
    paragraph('版本成果 · 可编辑文档', {
      spacing: { before: 540 },
      alignment: AlignmentType.RIGHT,
    }),
  )
  children.push(new Paragraph({ children: [new PageBreak()] }))
  if (plan.tableOfContents) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '目录',
            size: 36,
            bold: true,
            color: accent,
            font,
          }),
        ],
        spacing: { after: 320 },
      }),
    )
    children.push(
      new TableOfContents('目录', {
        hyperlink: true,
        headingStyleRange: '1-3',
      }),
    )
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  let tableCount = 0,
    imageCount = 0,
    orderedList = 0
  const numbering: {
    reference: string
    levels: {
      level: number
      format: typeof LevelFormat.DECIMAL
      text: string
      alignment: typeof AlignmentType.START
      style: { paragraph: { indent: { left: number; hanging: number } } }
    }[]
  }[] = []
  for (const section of plan.sections) {
    children.push(
      new Paragraph({
        heading: [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
        ][section.level - 1],
        pageBreakBefore: section.pageBreakBefore,
        keepNext: true,
        children: [new TextRun({ text: section.title, font })],
      }),
    )
    for (const block of section.blocks) {
      if (block.type === 'paragraph')
        children.push(
          paragraph(block.text, {
            widowControl: true,
            spacing: { after: 160, line: 340 },
          }),
        )
      if (block.type === 'list') {
        const reference = 'office-list-' + ++orderedList
        if (block.ordered)
          numbering.push({
            reference,
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '%1.',
                alignment: AlignmentType.START,
                style: { paragraph: { indent: { left: 420, hanging: 300 } } },
              },
            ],
          })
        for (const item of block.items)
          children.push(
            paragraph(item, {
              ...(block.ordered
                ? { numbering: { reference, level: 0 } }
                : { bullet: { level: 0 } }),
              spacing: { after: 100, line: 320 },
              widowControl: true,
            }),
          )
      }
      if (block.type === 'quote') {
        const source = sources.get(block.sourceId)
        if (
          !source ||
          !source.text
            .replace(/\s+/gu, '')
            .includes(block.text.replace(/\s+/gu, ''))
        )
          throw new OfficeInputError(
            `章节“${section.title}”的引用无法在授权资料中逐字核对`,
          )
        if (!citations.has(source.id))
          citations.set(source.id, citations.size + 1)
        children.push(
          paragraph(block.text + ' [' + citations.get(source.id) + ']', {
            indent: { left: 320, right: 320 },
            border: {
              left: {
                style: BorderStyle.SINGLE,
                color: accent,
                size: 16,
                space: 12,
              },
            },
            shading: { fill: 'F2F5F8' },
            spacing: { before: 160, after: 200, line: 340 },
          }),
        )
      }
      if (block.type === 'table') {
        tableCount++
        const width = Math.floor(9360 / block.columns.length)
        const capacity = Math.max(4, Math.floor((width - 200) / 210))
        for (const row of block.rows)
          if (
            Math.max(
              ...row.map((value) => Math.ceil(value.length / capacity)),
            ) > 32
          )
            throw new OfficeInputError(
              `章节“${section.title}”表格单行内容超过一页，请拆分行或改为段落`,
            )
        if (block.caption)
          children.push(
            paragraph('表 ' + tableCount + '  ' + block.caption, {
              keepNext: true,
              alignment: AlignmentType.CENTER,
              spacing: { before: 160, after: 120 },
            }),
          )
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            columnWidths: block.columns.map(() => width),
            rows: [block.columns, ...block.rows].map(
              (row, index) =>
                new TableRow({
                  tableHeader: index === 0,
                  cantSplit: true,
                  children: row.map(
                    (value) =>
                      new TableCell({
                        width: { size: width, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.CENTER,
                        shading: {
                          fill:
                            index === 0
                              ? accent
                              : index % 2 === 0
                                ? 'F3F6F8'
                                : 'FFFFFF',
                        },
                        margins: {
                          top: 100,
                          bottom: 100,
                          left: 100,
                          right: 100,
                        },
                        borders: Object.fromEntries(
                          ['top', 'bottom', 'left', 'right'].map((side) => [
                            side,
                            {
                              style: BorderStyle.SINGLE,
                              color: 'D8E1E8',
                              size: 4,
                            },
                          ]),
                        ),
                        children: [
                          new Paragraph({
                            spacing: { after: 0, line: 280 },
                            children: [
                              new TextRun({
                                text: value,
                                font,
                                size: 20,
                                bold: index === 0,
                                color: index === 0 ? 'FFFFFF' : '243746',
                              }),
                            ],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        )
        children.push(new Paragraph({ spacing: { after: 120 } }))
      }
      if (block.type === 'image') {
        const file = images.get(block.imageId)
        if (!file)
          throw new OfficeInputError(`图片 ${block.imageId} 不属于本次授权素材`)
        const dimensions = imageData(file)
        const scale = Math.min(
          570 / dimensions.width,
          550 / dimensions.height,
          1,
        )
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            keepNext: Boolean(block.caption),
            children: [
              new ImageRun({
                type: /\.png$/iu.test(file.filename) ? 'png' : 'jpg',
                data: file.content,
                transformation: {
                  width: Math.round(dimensions.width * scale),
                  height: Math.round(dimensions.height * scale),
                },
                altText: {
                  title: block.caption || section.title,
                  description: block.caption || section.title,
                  name: block.imageId,
                },
              }),
            ],
          }),
        )
        imageCount++
        if (block.caption)
          children.push(
            paragraph(
              '图 ' +
                imageCount +
                '  ' +
                block.caption.replace(/^图\s*\d+\s+/, ''),
              {
                alignment: AlignmentType.CENTER,
                spacing: { after: 180 },
              },
            ),
          )
      }
    }
  }
  if (citations.size) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: citations.size > 8,
        keepNext: true,
        text: '资料来源',
      }),
    )
    for (const [id, number] of citations)
      children.push(
        paragraph('[' + number + '] ' + sources.get(id)!.filename + ' · ' + id),
      )
  }
  const document = new Document({
    title: plan.title,
    creator: 'SuperDsh',
    description: plan.purpose,
    features: { updateFields: true },
    externalStyles: template?.externalStyles,
    styles: {
      default: {
        document: {
          run: { font, size: 22, color: '243746' },
          paragraph: { spacing: { line: 340, after: 160 } },
        },
        heading1: {
          run: { font, size: 32, bold: true, color: accent },
          paragraph: { spacing: { before: 320, after: 180 }, keepNext: true },
        },
        heading2: {
          run: { font, size: 27, bold: true, color: accent },
          paragraph: { spacing: { before: 260, after: 140 }, keepNext: true },
        },
        heading3: {
          run: { font, size: 24, bold: true },
          paragraph: { spacing: { before: 220, after: 100 }, keepNext: true },
        },
      },
    },
    numbering: { config: numbering },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: 1440,
              right: 1273,
              bottom: 1440,
              left: 1273,
              header: 720,
              footer: 720,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: {
                  bottom: {
                    style: BorderStyle.SINGLE,
                    size: 4,
                    color: 'D8E1E8',
                    space: 8,
                  },
                },
                children: [
                  new TextRun({
                    text: plan.brand.company || plan.title,
                    font,
                    size: 18,
                    color: '657887',
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [
                      '第 ',
                      PageNumber.CURRENT,
                      ' 页 / 共 ',
                      PageNumber.TOTAL_PAGES,
                      ' 页',
                    ],
                    font,
                    size: 18,
                    color: '657887',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })
  let content = await Packer.toBuffer(document)
  if (template) {
    content = await applyDocumentTemplate(content, template)
    diagnostics.push({
      severity: 'info',
      code: 'template-retained',
      message: '已复用企业样式及页眉页脚素材；正文按确认的章节结构生成。',
    })
  }
  diagnostics.push({
    severity: 'info',
    code: 'requires-render',
    message: '结构和引用已检查；页数、字体和分页仍以最终 DOCX 的实际渲染为准。',
  })
  return {
    filename:
      plan.title.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '_').slice(0, 100) +
      '.docx',
    content,
    mediaType: DOCX_MEDIA_TYPE,
    diagnostics,
    pages: plan.sections.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
    })),
    summary: {
      sections: plan.sections.length,
      tables: tableCount,
      images: imageCount,
      citations: citations.size,
      editable: true,
    },
  }
}
