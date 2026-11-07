import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, Header, Footer, TextRun } from 'docx'
import {
  generateOfficeDocument,
  validateOfficeDocumentPlan,
  inspectDocumentTemplate,
} from '../agents/office/document.ts'
import { officeWork } from '../agents/office-worker-client.ts'

const plan = (
  blocks = [
    { type: 'paragraph', text: '本制度适用于星河科技（脱敏）的试用团队。' },
  ],
) => ({
  title: '星河公司办公制度',
  brand: { company: '星河科技（脱敏）' },
  sections: [{ id: 'scope', title: '适用范围', blocks }],
})
const generate = (value) =>
  generateOfficeDocument({ plan: validateOfficeDocumentPlan(value) })
const xml = async (artifact) =>
  (await JSZip.loadAsync(artifact.content))
    .file('word/document.xml')
    .async('string')

test('Word output contains real editable document structure, TOC, headings, headers and page fields', async () => {
  const artifact = await generate(plan())
  const zip = await JSZip.loadAsync(artifact.content)
  const document = await xml(artifact)
  assert.equal(
    artifact.mediaType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  assert.match(document, /适用范围/)
  assert.match(document, /Heading1/)
  assert.match(document, /TOC/)
  assert.match(document, /w:w="11906"/)
  assert.match(await zip.file('word/footer1.xml').async('string'), /PAGE/)
  assert.ok(zip.file('word/styles.xml'))
})

test('Word tables retain repeatable headers, exact values and independently editable cells', async () => {
  const artifact = await generate(
    plan([
      {
        type: 'table',
        caption: '费用报销标准',
        columns: ['项目', '金额'],
        rows: [
          ['交通费', '1234.56'],
          ['退款', '-12.34'],
        ],
      },
    ]),
  )
  const document = await xml(artifact)
  assert.match(document, /w:tblHeader/)
  assert.match(document, /1234\.56/)
  assert.match(document, /-12\.34/)
  assert.equal(artifact.summary.tables, 1)
})

test('Word source quotations must match an authorized source, not a claimed source ID', async () => {
  const input = plan([
    { type: 'quote', text: '员工每月可申请两次培训。', sourceId: 'source-1' },
  ])
  await assert.rejects(() => generate(input), /授权资料/)
  await assert.rejects(
    () =>
      generateOfficeDocument({
        plan: validateOfficeDocumentPlan(input),
        sources: [
          {
            id: 'source-1',
            filename: '制度.md',
            text: '员工每月可申请一次培训。',
          },
        ],
      }),
    /逐字核对/,
  )
  const artifact = await generateOfficeDocument({
    plan: validateOfficeDocumentPlan(input),
    sources: [
      {
        id: 'source-1',
        filename: '制度.md',
        text: '培训制度\n员工每月可申请两次培训。',
      },
    ],
  })
  assert.match(await xml(artifact), /资料来源/)
  assert.equal(artifact.summary.citations, 1)
  const sourceHeading = (await xml(artifact))
    .match(/<w:p[ >][\s\S]*?<\/w:p>/g)
    .find((paragraph) => paragraph.includes('资料来源'))
  assert.doesNotMatch(sourceHeading, /<w:pageBreakBefore\s*\/>/)
})

test('Word assigns a single figure number when the model supplies a numbered caption', async () => {
  const artifact = await generateOfficeDocument({
    plan: validateOfficeDocumentPlan(
      plan([{ type: 'image', imageId: 'figure', caption: '图1  交付流程' }]),
    ),
    images: [
      {
        id: 'figure',
        file: {
          filename: 'figure.png',
          content: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
            'base64',
          ),
        },
      },
    ],
  })
  const document = await xml(artifact)
  assert.match(document, /图 1 {2}交付流程/)
  assert.doesNotMatch(document, /图 1 {2}图1/)
})

test('Word unknown image IDs and overlong rows fail before exporting a misleading document', async () => {
  await assert.rejects(
    () => generate(plan([{ type: 'image', imageId: 'another-session-image' }])),
    /授权素材/,
  )
  await assert.rejects(
    () =>
      generate(
        plan([
          {
            type: 'table',
            columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
            rows: [Array(8).fill('中文'.repeat(300))],
          },
        ]),
      ),
    /超过一页/,
  )
})

test('Word preserves company header/footer text and styles from a real template', async () => {
  const content = await Packer.toBuffer(
    new Document({
      sections: [
        {
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: '星河科技内部资料', bold: true }),
                  ],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({ children: [new Paragraph('保留企业页脚')] }),
          },
          children: [new Paragraph('占位正文')],
        },
      ],
    }),
  )
  const template = { filename: '企业模板.docx', content }
  const inspected = await inspectDocumentTemplate(template)
  assert.equal(inspected.headerCount, 1)
  const artifact = await generateOfficeDocument({
    plan: validateOfficeDocumentPlan(plan()),
    template,
  })
  const zip = await JSZip.loadAsync(artifact.content)
  assert.match(
    await zip.file('word/template-assets/header1.xml').async('string'),
    /星河科技内部资料/,
  )
  assert.match(
    await zip.file('word/template-assets/footer1.xml').async('string'),
    /保留企业页脚/,
  )
  assert.doesNotMatch(await xml(artifact), /占位正文/)
  assert.match(
    await zip.file('word/_rels/document.xml.rels').async('string'),
    /template-assets/,
  )
})

test('Word rejects complex template sections explicitly', async () => {
  const content = await Packer.toBuffer(
    new Document({
      sections: [
        { children: [new Paragraph('第一节')] },
        { children: [new Paragraph('第二节')] },
      ],
    }),
  )
  await assert.rejects(
    () =>
      generateOfficeDocument({
        plan: validateOfficeDocumentPlan(plan()),
        template: { filename: '分节.docx', content },
      }),
    /单节/,
  )
})

test('Word worker returns an actual OOXML document through the same office boundary', async () => {
  const result = await officeWork(
    'generate',
    'document_report',
    [],
    plan(),
    new AbortController().signal,
  )
  assert.match(result.filename, /\.docx$/)
  assert.match(await xml({ content: Buffer.from(result.content) }), /适用范围/)
})

for (const [title, value, message] of [
  [
    'duplicate section IDs',
    { ...plan(), sections: [...plan().sections, ...plan().sections] },
    /不能重复/,
  ],
  [
    'invalid heading levels',
    { ...plan(), sections: [{ ...plan().sections[0], level: 4 }] },
    /标题级别/,
  ],
  [
    'unsupported executable block',
    plan([{ type: 'script', text: 'run' }]),
    /只支持/,
  ],
  [
    'inconsistent table columns',
    plan([{ type: 'table', columns: ['a', 'b'], rows: [['a']] }]),
    /列数/,
  ],
  ['missing content', { ...plan(), sections: [] }, /章节/],
  ['font paths', { ...plan(), brand: { fontFace: '../private.ttf' } }, /字体/],
  [
    'invalid colors',
    { ...plan(), brand: { accentColor: 'javascript:' } },
    /主题色/,
  ],
])
  test('Word preflight rejects ' + title, () =>
    assert.throws(() => validateOfficeDocumentPlan(value), message),
  )
