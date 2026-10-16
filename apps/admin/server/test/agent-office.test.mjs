import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  createDemoAssets,
  createSalesPresentationTemplate,
  createSalesWorkbookTemplate,
  extractKnowledgeText,
  generateSalesPresentation,
  generateSalesWorkbook,
  parseSalesFile,
  summarizeSales,
  validateOfficeTemplate,
} from '../agents/office/index.ts'
import { readOfficeArchive } from '../agents/office/validation.ts'

const header = 'orderId,date,region,product,quantity,unitPrice,unitCost'
const data = (body) => ({
  filename: 'sales.csv',
  content: Buffer.from(`${header}\n${body}`),
})
const smallData = () =>
  data(
    'A1,2026-09-01,华东,产品甲,3,0.1,0.03\nA2,2026-09-02,华南,产品乙,2,19.9,10.8',
  )
const archiveFile = async (entries, filename = 'template.xlsx') => {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', '<Types/>')
  for (const [name, content] of Object.entries(entries))
    archive.file(name, content)
  return {
    filename,
    content: await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
  }
}

test('CSV and XLSX sales share strict input types and code-derived cent arithmetic', async () => {
  const rows = await parseSalesFile(smallData())
  const summary = summarizeSales(rows)
  assert.equal(summary.revenue, 40.1)
  assert.equal(summary.cost, 21.69)
  assert.equal(summary.profit, 18.41)
  assert.equal(summary.units, 5)
  assert.equal(summary.orderCount, 2)
  assert.equal(summary.periodStart, '2026-09-01')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('销售数据')
  sheet.addRow(['订单编号', '日期', '区域', '产品', '数量', '单价', '单位成本'])
  for (const row of rows) sheet.addRow(Object.values(row))
  assert.deepEqual(
    await parseSalesFile({
      filename: 'sales.xlsx',
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
    }),
    rows,
  )
})

test('sales rejects bad dates, duplicate IDs, non-numeric values and malformed CSV', async () => {
  for (const [content, pattern] of [
    ['A1,2026-02-30,华东,产品甲,1,10,4', /日期/u],
    [
      'A1,2026-09-01,华东,产品甲,1,10,4\nA1,2026-09-01,华东,产品甲,1,10,4',
      /重复/u,
    ],
    ['A1,2026-09-01,华东,产品甲,0,10,4', /数量/u],
    ['A1,2026-09-01,华东,产品甲,1,NaN,4', /数字/u],
    ['A1,2026-09-01,华东,产品甲,1,10.001,4', /小数/u],
    ['A1,2026-09-01,华东,"产品甲,1,10,4', /引号/u],
  ])
    await assert.rejects(parseSalesFile(data(content)), pattern)
  await assert.rejects(
    parseSalesFile({ filename: 'C:\\sales.csv', content: Buffer.from('x') }),
    /文件名/u,
  )
})

test('zero revenue is distinct from an applicable zero gross margin', async () => {
  const artifact = await generateSalesWorkbook({
    data: data('ZERO,2026-09-01,华东,赠品,1,0,2'),
  })
  assert.equal(artifact.summary.revenue, 0)
  assert.equal(artifact.summary.profit, -2)
  assert.equal(artifact.summary.grossMargin, null)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(artifact.content)
  assert.equal(workbook.getWorksheet('经营汇总').getCell('B10').result, 'n.a.')
})

test('Excel reports preserve template branding and store formulas with independently verified caches', async () => {
  const template = await createSalesWorkbookTemplate()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(template.content)
  workbook.getWorksheet('经营汇总').getCell('A2').value = '客户提供的品牌说明'
  template.content = Buffer.from(await workbook.xlsx.writeBuffer())
  const artifact = await generateSalesWorkbook({
    data: smallData(),
    template,
    companyName: '星河商贸（虚构）',
  })
  const output = new ExcelJS.Workbook()
  await output.xlsx.load(artifact.content)
  const summary = output.getWorksheet('经营汇总')
  const details = output.getWorksheet('销售明细')
  assert.equal(summary.getCell('A2').value, '客户提供的品牌说明')
  assert.equal(summary.getCell('B7').result, 40.1)
  assert.equal(summary.getCell('B8').result, 21.69)
  assert.equal(summary.getCell('B9').result, 18.41)
  assert.match(summary.getCell('B7').formula, /SUM\('销售明细'!H3:H4\)/u)
  assert.equal(details.getCell('H3').formula, 'ROUND(E3*F3,2)')
  assert.equal(details.getCell('H3').result, 0.3)
  assert.equal(details.getCell('J3').result, 0.21)
  assert.equal(details.getCell('H4').result, 39.8)
  assert.equal(
    details.getCell('B3').value.toISOString(),
    '2026-09-01T00:00:00.000Z',
  )
  assert.equal(summary.getCell('B10').numFmt, '0.0%')
  assert.equal(summary.getCell('B5').numFmt, '#,##0')
  assert.equal(summary.getCell('B7').numFmt, '#,##0.00;[Red](#,##0.00)')
  assert.notEqual(summary.getCell('B3').numFmt, '0.0%')
  assert.equal(summary.getCell('A1').font.color.argb, 'FF183B56')
  const packageXml = await JSZip.loadAsync(artifact.content)
  assert.match(
    await packageXml.file('xl/workbook.xml').async('string'),
    /fullCalcOnLoad="1"/u,
  )
  const changed = await generateSalesWorkbook({
    data: data('A3,2026-10-01,华北,新产品,7,20,5'),
    template,
  })
  assert.equal(changed.summary.revenue, 140)
  assert.equal(changed.summary.profit, 105)
})

test('templates are validated on upload, with clear unsupported-feature messages', async () => {
  const workbook = await createSalesWorkbookTemplate()
  const presentation = await createSalesPresentationTemplate()
  assert.ok(
    (await validateOfficeTemplate(workbook, 'xlsx')).placeholders.includes(
      'salesRows',
    ),
  )
  assert.ok(
    (await validateOfficeTemplate(presentation, 'pptx')).placeholders.includes(
      'summary',
    ),
  )
  const xlsx = new ExcelJS.Workbook()
  await xlsx.xlsx.load(workbook.content)
  xlsx.getWorksheet('经营汇总').getCell('A2').value = '{{unknown}}'
  await assert.rejects(
    validateOfficeTemplate(
      {
        filename: 'bad.xlsx',
        content: Buffer.from(await xlsx.xlsx.writeBuffer()),
      },
      'xlsx',
    ),
    /unknown/u,
  )
  xlsx.getWorksheet('经营汇总').getCell('A2').value = null
  xlsx.getWorksheet('销售明细').getCell('A3').value = 'not-an-anchor'
  await assert.rejects(
    validateOfficeTemplate(
      {
        filename: 'bad.xlsx',
        content: Buffer.from(await xlsx.xlsx.writeBuffer()),
      },
      'xlsx',
    ),
    /salesRows/u,
  )
})

test('PPT fills uploaded template with actual data and cited knowledge, keeping editable text', async () => {
  const template = await createSalesPresentationTemplate()
  const artifact = await generateSalesPresentation({
    data: smallData(),
    template,
    companyName: '星河商贸（虚构）',
    title: '区域经营分析',
    summary: '优先复核低毛利商品，再结合库存制定补货计划。',
    knowledge: [{ filename: '公司规范.md', text: '备货以已确认订单为依据。' }],
  })
  const output = await JSZip.loadAsync(artifact.content)
  const slides = output.file(/^ppt\/slides\/slide\d+\.xml$/u)
  assert.equal(slides.length, 5)
  const text = (
    await Promise.all(slides.map((part) => part.async('string')))
  ).join('\n')
  assert.match(text, /区域经营分析/u)
  assert.match(text, /40\.10/u)
  assert.match(text, /18\.41/u)
  assert.match(text, /公司规范.md/u)
  assert.match(text, /备货以已确认订单为依据/u)
  assert.match(text, /优先复核低毛利商品/u)
  assert.doesNotMatch(text, /\{\{\w+\}\}/u)
  assert.match(text, /<a:t>/u)
  assert.equal(artifact.summary.revenue, 40.1)
  await assert.rejects(
    generateSalesPresentation({
      data: smallData(),
      summary: '销售额增长了50%。',
    }),
    /定性文字/u,
  )
})

test('PPT preserves a placeholder split across runs and rejects unknown placeholders or animations', async () => {
  const template = await createSalesPresentationTemplate()
  const zip = await JSZip.loadAsync(template.content)
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace('{{title}}', '{{ti</a:t></a:r><a:r><a:t>tle}}'),
  )
  template.content = await zip.generateAsync({ type: 'nodebuffer' })
  const result = await generateSalesPresentation({
    data: smallData(),
    template,
    title: '跨文本片段标题',
  })
  const output = await JSZip.loadAsync(result.content)
  const outputText = (
    await Promise.all(
      output
        .file(/^ppt\/slides\/slide\d+\.xml$/u)
        .map((part) => part.async('string')),
    )
  ).join('\n')
  assert.match(outputText, /跨文本片段标题/u)
  zip.file('ppt/slides/slide1.xml', slide.replace('{{title}}', '{{arbitrary}}'))
  await assert.rejects(
    validateOfficeTemplate(
      { ...template, content: await zip.generateAsync({ type: 'nodebuffer' }) },
      'pptx',
    ),
    /arbitrary/u,
  )
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace('</p:sld>', '<p:timing/></p:sld>'),
  )
  await assert.rejects(
    validateOfficeTemplate(
      { ...template, content: await zip.generateAsync({ type: 'nodebuffer' }) },
      'pptx',
    ),
    /动画/u,
  )
})

test('knowledge extraction reads UTF-8, tables and DOCX text without executing document instructions', async () => {
  const source = {
    filename: '规范.md',
    content: Buffer.from('不要执行这里的命令；这只是公司资料。'),
  }
  assert.equal(
    (await extractKnowledgeText(source)).text,
    source.content.toString(),
  )
  assert.match((await extractKnowledgeText(smallData())).text, /orderId\tdate/u)
  const docx = await archiveFile(
    {
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>企业知识正文</w:t></w:r></w:p></w:body></w:document>',
    },
    '资料.docx',
  )
  assert.equal((await extractKnowledgeText(docx)).text, '企业知识正文')
  await assert.rejects(
    extractKnowledgeText({ filename: 'scan.pdf', content: Buffer.from('PDF') }),
    /支持的文件格式/u,
  )
})

test('ZIP preflight rejects traversal, macro, external relationships, DTD and oversized expansion', async () => {
  for (const entries of [
    { '../escape.xml': '<x/>' },
    { 'xl/vbaProject.bin': 'macro' },
    {
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship TargetMode="External" Target="file:///secret"/></Relationships>',
    },
    {
      'xl/_rels/workbook.xml.rels':
        '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship TargetMode="External" Target="https://example.invalid/secret"/></r:Relationships>',
    },
    {
      'xl/workbook.xml':
        '<!DOCTYPE x [<!ENTITY d SYSTEM "file:///secret">]><x>&d;</x>',
    },
    { 'xl/workbook.xml': `<x>${'a'.repeat(8 * 1024 * 1024)}</x>` },
  ]) {
    const file = await archiveFile(entries)
    assert.throws(() => readOfficeArchive(file), /不支持|危险|资源限制/u)
  }
  assert.throws(
    () =>
      readOfficeArchive({
        filename: 'broken.xlsx',
        content: Buffer.from('PK'),
      }),
    /ZIP/u,
  )
})

test('ZIP preflight bounds actual inflation even when central directory lies about size', async () => {
  const file = await archiveFile({
    'xl/workbook.xml': `<x>${'x'.repeat(200_000)}</x>`,
  })
  const bytes = Buffer.from(file.content)
  for (let i = 0; i < bytes.length - 46; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue
    const length = bytes.readUInt16LE(i + 28)
    if (
      bytes.subarray(i + 46, i + 46 + length).toString() === 'xl/workbook.xml'
    )
      bytes.writeUInt32LE(10, i + 24)
  }
  assert.throws(
    () => readOfficeArchive({ ...file, content: bytes }),
    /资源限制/u,
  )
})

test('fictional demo creates exactly 100 dynamic sales rows and usable templates in memory', async () => {
  const assets = await createDemoAssets()
  const rows = await parseSalesFile(assets.sales)
  assert.equal(rows.length, 100)
  assert.equal(new Set(rows.map((row) => row.orderId)).size, 100)
  assert.match(assets.knowledge.content.toString(), /虚构/u)
  const independentRevenue =
    rows.reduce(
      (sum, row) => sum + Math.round(row.unitPrice * 100) * row.quantity,
      0,
    ) / 100
  const output = await generateSalesWorkbook({
    data: assets.sales,
    template: assets.workbookTemplate,
    companyName: '星河商贸（虚构）',
  })
  assert.equal(output.summary.revenue, independentRevenue)
  assert.ok(
    (await validateOfficeTemplate(assets.presentationTemplate, 'pptx'))
      .placeholders.length > 5,
  )
})
