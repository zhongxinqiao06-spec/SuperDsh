import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import {
  generateOfficePresentation,
  inspectOfficePresentationTemplate,
  validateOfficePresentationPlan,
} from '../agents/office/generic-presentation.ts'
import {
  createSalesPresentationTemplate,
  generateSalesPresentation,
} from '../agents/office/presentation.ts'
import { readOfficeArchive } from '../agents/office/validation.ts'

const plan = (...slides) => ({ title: '星河企业资料（脱敏）', slides })
const textSlide = (
  id = 'intro',
  title = '公司介绍',
  body = ['提供企业办公软件与实施服务。'],
) => ({ id, kind: 'content', title, body })
const chartSlide = (type = 'bar') => ({
  id: 'chart',
  kind: 'chart',
  title: '季度项目数量',
  chart: {
    type,
    categories: ['第一季度', '第二季度', '第三季度'],
    series: [{ name: '项目数', values: [12, 18, 16] }],
    valueUnit: '个',
  },
})
const tableSlide = () => ({
  id: 'table',
  kind: 'table',
  title: '实施计划',
  table: {
    columns: ['阶段', '交付成果', '时长'],
    rows: [
      ['需求确认', '需求清单', '一周'],
      ['试运行', '验收记录', '两周'],
    ],
  },
})
async function xml(artifact, pattern = /^ppt\/slides\/slide\d+\.xml$/u) {
  const archive = await JSZip.loadAsync(artifact.content)
  return (
    await Promise.all(archive.file(pattern).map((part) => part.async('string')))
  ).join('\n')
}
async function companyTemplate() {
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  for (let index = 0; index < 2; index++) {
    const slide = deck.addSlide()
    slide.background = { color: index === 0 ? 'FFFFFF' : 'F0F5FA' }
    slide.addText(`原始标题 ${index + 1}`, {
      x: 0.6,
      y: 0.5,
      w: 11.8,
      h: 0.9,
      fontSize: 32,
      objectName: 'title',
    })
    slide.addText('待替换的正文内容', {
      x: 0.6,
      y: 1.7,
      w: 11.8,
      h: 4.8,
      fontSize: 20,
      objectName: 'body',
    })
    slide.addText(`星河品牌 ${index + 1}`, {
      x: 0.6,
      y: 6.9,
      w: 10,
      h: 0.3,
      fontSize: 11,
      objectName: 'brand',
    })
  }
  return {
    filename: '公司模板.pptx',
    content: Buffer.from(await deck.write({ outputType: 'nodebuffer' })),
  }
}

test('01 company introduction generates an editable deck without sales data', async () => {
  const result = await generateOfficePresentation({
    plan: plan(
      {
        id: 'cover',
        kind: 'title',
        title: '星河商贸',
        body: ['公司介绍与客户服务'],
      },
      textSlide(),
    ),
  })
  assert.equal(result.pages.length, 2)
  assert.match(await xml(result), /公司介绍与客户服务/u)
  assert.match(await xml(result), /<a:t>提供企业办公软件/u)
  assert.equal(
    (await inspectOfficePresentationTemplate(result)).slides.length,
    2,
  )
})

test('02 training content preserves Chinese paragraphs and explicit audience', async () => {
  const result = await generateOfficePresentation({
    plan: {
      ...plan(
        textSlide('process', '报销流程', [
          '提交原始凭证。',
          '由部门负责人审核。',
          '财务核对后付款。',
        ]),
      ),
      audience: '新员工',
      purpose: '掌握报销流程',
    },
  })
  assert.match(await xml(result), /财务核对后付款/u)
  assert.doesNotMatch(await xml(result), /销售额|毛利/u)
})

test('03 solution tables remain native editable tables with exact row values', async () => {
  const result = await generateOfficePresentation({ plan: plan(tableSlide()) })
  const content = await xml(result)
  assert.match(content, /<a:tbl>/u)
  assert.match(content, /需求清单/u)
  assert.equal((content.match(/<a:tr /gu) ?? []).length, 3)
})

test('04 bar charts embed editable workbooks and retain exact numerical series', async () => {
  const result = await generateOfficePresentation({ plan: plan(chartSlide()) })
  const archive = readOfficeArchive(result, { allowChartWorkbooks: true })
  assert.equal(archive.file(/^ppt\/charts\/chart\d+\.xml$/u).length, 1)
  assert.equal(archive.file(/^ppt\/embeddings\/.*\.xlsx$/u).length, 1)
  const chart = await archive.file('ppt/charts/chart1.xml').async('string')
  assert.match(chart, /<c:v>18<\/c:v>/u)
  assert.match(chart, /项目数/u)
  assert.throws(() => readOfficeArchive(result), /嵌入对象/u)
})

test('05 line charts support multiple series and preserve negative values', async () => {
  const slide = chartSlide('line')
  slide.chart.series.push({ name: '同比变化', values: [-2, 3, 4] })
  const result = await generateOfficePresentation({ plan: plan(slide) })
  const content = await xml(result, /^ppt\/charts\/chart\d+\.xml$/u)
  assert.match(content, /<c:lineChart>/u)
  assert.match(content, /<c:v>-2<\/c:v>/u)
})

test('06 pie charts reject negative or zero totals rather than misleading percentages', async () => {
  const result = await generateOfficePresentation({
    plan: plan(chartSlide('pie')),
  })
  assert.match(
    await xml(result, /^ppt\/charts\/chart\d+\.xml$/u),
    /<c:pieChart>/u,
  )
  for (const values of [
    [0, 0, 0],
    [1, -2, 3],
  ]) {
    const slide = chartSlide('pie')
    slide.chart.series[0].values = values
    assert.throws(() => validateOfficePresentationPlan(plan(slide)), /饼图/u)
  }
})

test('07 uploaded PNG is embedded once with its original aspect ratio', async () => {
  const file = {
    filename: '标志.png',
    content: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4JkAAAAASUVORK5CYII=',
      'base64',
    ),
  }
  const result = await generateOfficePresentation({
    plan: plan({
      id: 'logo',
      kind: 'image',
      title: '公司标志',
      imageId: 'asset-logo',
    }),
    images: [{ id: 'asset-logo', file }],
  })
  assert.match(await xml(result), /<p:pic>/u)
  const archive = await JSZip.loadAsync(result.content)
  assert.deepEqual(
    await archive.file(/^ppt\/media\/.*\.png$/u)[0].async('nodebuffer'),
    file.content,
  )
})

test('08 more than three knowledge sources remain cited in speaker notes', async () => {
  const sources = Array.from({ length: 12 }, (_, index) => ({
    id: `source-${index}`,
    filename: `制度-${index}.md`,
    text: '脱敏制度正文',
  }))
  const result = await generateOfficePresentation({
    plan: plan({
      ...textSlide(),
      sourceIds: sources.map((source) => source.id),
    }),
    sources,
  })
  const notes = await xml(result, /^ppt\/notesSlides\/notesSlide\d+\.xml$/u)
  assert.match(notes, /制度-11.md/u)
  assert.equal(result.pages[0].sourceIds.length, 12)
})

test('09 ordinary company templates need no magic placeholders and retain brand content', async () => {
  const template = await companyTemplate()
  const result = await generateOfficePresentation({
    template,
    plan: plan({
      ...textSlide(),
      template: { slide: 1, titleShape: 'title', bodyShape: 'body' },
    }),
  })
  const content = await xml(result)
  assert.match(content, /星河品牌 1/u)
  assert.match(content, /提供企业办公软件/u)
  assert.doesNotMatch(content, /原始标题|待替换/u)
})

test('10 visible slide order follows relationships even after slide reordering', async () => {
  const template = await companyTemplate()
  const archive = await JSZip.loadAsync(template.content)
  const presentation = await archive
    .file('ppt/presentation.xml')
    .async('string')
  const ids = presentation.match(/<p:sldId [^>]+\/>/gu)
  archive.file(
    'ppt/presentation.xml',
    presentation.replace(ids.join(''), [...ids].reverse().join('')),
  )
  template.content = await archive.generateAsync({ type: 'nodebuffer' })
  const inspection = await inspectOfficePresentationTemplate(template)
  assert.equal(inspection.slides[0].partNumber, 2)
  const result = await generateOfficePresentation({
    template,
    plan: plan({ ...textSlide(), template: { slide: 1 } }),
  })
  assert.match(await xml(result), /星河品牌 2/u)
  assert.doesNotMatch(await xml(result), /星河品牌 1/u)
})

test('11 mapped company template supports native charts, tables and source notes', async () => {
  const template = await companyTemplate()
  const result = await generateOfficePresentation({
    template,
    sources: [{ id: 'report', filename: '季度统计.xlsx', text: '脱敏数据' }],
    plan: plan(
      { ...chartSlide(), sourceIds: ['report'], template: { slide: 1 } },
      { ...tableSlide(), template: { slide: 2 } },
    ),
  })
  const archive = readOfficeArchive(result, { allowChartWorkbooks: true })
  assert.equal(archive.file(/^ppt\/charts\/chart\d+\.xml$/u).length, 1)
  assert.match(await xml(result), /<a:tbl>/u)
  assert.match(
    await xml(result, /^ppt\/notesSlides\/office-notes-\d+\.xml$/u),
    /季度统计.xlsx/u,
  )
})

test('12 long Chinese text is blocked before creating unreadable overflow', async () => {
  await assert.rejects(
    generateOfficePresentation({
      plan: plan(
        textSlide('too-long', '培训内容', ['长篇中文说明'.repeat(95)]),
      ),
    }),
    /超出可读版面/u,
  )
  await assert.rejects(
    generateOfficePresentation({
      plan: plan(textSlide('title', '特别长的标题'.repeat(12))),
    }),
    /标题超出/u,
  )
})

test('13 table preflight catches crowded rows and wide cell content', async () => {
  const slide = tableSlide()
  slide.table.rows = Array.from({ length: 15 }, () => [
    '中文长文本'.repeat(18),
    '需要另外拆页',
    '一周',
  ])
  await assert.rejects(
    generateOfficePresentation({ plan: plan(slide) }),
    /单元格超出/u,
  )
})

test('14 tables validate row shape, finite numbers and per-page limits', () => {
  const slide = tableSlide()
  slide.table.rows = [['只有一列']]
  assert.throws(() => validateOfficePresentationPlan(plan(slide)), /列数/u)
  slide.table.rows = [['计划', Infinity, '一周']]
  assert.throws(() => validateOfficePresentationPlan(plan(slide)), /有限数字/u)
  slide.table.rows = Array.from({ length: 16 }, () => ['计划', 1, '一周'])
  assert.throws(() => validateOfficePresentationPlan(plan(slide)), /1–15/u)
})

test('15 charts reject missing categories and nonfinite model numbers', () => {
  const slide = chartSlide()
  slide.chart.series[0].values = [12]
  assert.throws(() => validateOfficePresentationPlan(plan(slide)), /长度/u)
  slide.chart.series[0].values = [1, NaN, 3]
  assert.throws(() => validateOfficePresentationPlan(plan(slide)), /有限数字/u)
})

test('16 template mapping requires explicit page selection and valid named regions', async () => {
  const template = await companyTemplate()
  await assert.rejects(
    generateOfficePresentation({ template, plan: plan(textSlide()) }),
    /映射/u,
  )
  await assert.rejects(
    generateOfficePresentation({
      template,
      plan: plan({
        ...textSlide(),
        template: { slide: 1, titleShape: 'missing' },
      }),
    }),
    /未找到/u,
  )
  await assert.rejects(
    generateOfficePresentation({
      template,
      plan: plan({
        ...textSlide(),
        template: { slide: 1, contentRegion: { x: 0, y: 0, w: 50, h: 50 } },
      }),
    }),
    /重叠|越界/u,
  )
})

test('17 template effects and external references fail preflight explicitly', async () => {
  const template = await companyTemplate()
  const archive = await JSZip.loadAsync(template.content)
  const original = await archive.file('ppt/slides/slide1.xml').async('string')
  archive.file(
    'ppt/slides/slide1.xml',
    original.replace('</p:sld>', '<p:timing/></p:sld>'),
  )
  await assert.rejects(
    inspectOfficePresentationTemplate({
      ...template,
      content: await archive.generateAsync({ type: 'nodebuffer' }),
    }),
    /动画/u,
  )
  archive.file('ppt/slides/slide1.xml', original)
  archive.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<Relationships><Relationship Id="bad" TargetMode="External" Target="file:///private"/></Relationships>',
  )
  await assert.rejects(
    inspectOfficePresentationTemplate({
      ...template,
      content: await archive.generateAsync({ type: 'nodebuffer' }),
    }),
    /外部链接/u,
  )
})

test('18 missing or cross-account references cannot be invented by the plan', async () => {
  await assert.rejects(
    generateOfficePresentation({
      plan: plan({ ...textSlide(), sourceIds: ['other-user-file'] }),
    }),
    /未授权资料/u,
  )
  await assert.rejects(
    generateOfficePresentation({
      plan: plan({
        id: 'pic',
        kind: 'image',
        title: '资料',
        imageId: 'file:///private.png',
      }),
    }),
    /已授权图片/u,
  )
})

test('19 cancellation is distinguishable and does not generate an output', async () => {
  const abort = new AbortController()
  abort.abort(new Error('fixture cancellation'))
  await assert.rejects(
    generateOfficePresentation({
      plan: plan(textSlide()),
      signal: abort.signal,
    }),
    /fixture cancellation/u,
  )
})

test('20 revised full plans retain unchanged page IDs while replacing and adding content', async () => {
  const originalPlan = plan(textSlide('intro'), tableSlide())
  const original = await generateOfficePresentation({ plan: originalPlan })
  const originalBytes = Buffer.from(original.content)
  const revised = await generateOfficePresentation({
    plan: plan(
      tableSlide(),
      textSlide('intro', '新版公司介绍', ['新增培训与咨询服务。']),
      textSlide('summary', '下一步', ['安排试用。']),
    ),
  })
  assert.deepEqual(
    revised.pages.map((page) => page.id),
    ['table', 'intro', 'summary'],
  )
  assert.match(await xml(revised), /新增培训/u)
  assert.deepEqual(original.content, originalBytes)
  assert.doesNotMatch(await xml(original), /新增培训/u)
})

test('21 plans enforce distinct stable slide identities and maximum slide count', () => {
  assert.throws(
    () => validateOfficePresentationPlan(plan(textSlide(), textSlide())),
    /重复/u,
  )
  assert.throws(
    () =>
      validateOfficePresentationPlan(
        plan(
          ...Array.from({ length: 21 }, (_, index) => textSlide(`p-${index}`)),
        ),
      ),
    /1–20/u,
  )
})

test('22 chart embedded files never relax macro, external-link or unrelated package defenses', async () => {
  const result = await generateOfficePresentation({ plan: plan(chartSlide()) })
  const archive = await JSZip.loadAsync(result.content)
  archive.file('ppt/embeddings/evil.exe', 'bad')
  assert.throws(
    () =>
      readOfficeArchive(
        { ...result, content: Buffer.alloc(0) },
        { allowChartWorkbooks: true },
      ),
    /不能为空/u,
  )
  const bytes = await archive.generateAsync({ type: 'nodebuffer' })
  assert.throws(
    () =>
      readOfficeArchive(
        { ...result, content: bytes },
        { allowChartWorkbooks: true },
      ),
    /嵌入对象/u,
  )
  archive.remove('ppt/embeddings/evil.exe')
  archive.file('ppt/embeddings/unreferenced.xlsx', 'invalid')
  const unrelated = await archive.generateAsync({ type: 'nodebuffer' })
  assert.throws(
    () =>
      readOfficeArchive(
        { ...result, content: unrelated },
        { allowChartWorkbooks: true },
      ),
    /非图表引用/u,
  )
})

test('23 legacy sales entry remains compatible and accepts four knowledge documents', async () => {
  const result = await generateSalesPresentation({
    data: {
      filename: 'sales.csv',
      content: Buffer.from(
        'orderId,date,region,product,quantity,unitPrice,unitCost\nA1,2026-10-01,华东,产品甲,2,15,6',
      ),
    },
    template: await createSalesPresentationTemplate(),
    knowledge: Array.from({ length: 4 }, (_, index) => ({
      filename: `公司制度${index}.md`,
      text: '按已确认订单备货。',
    })),
  })
  assert.match(await xml(result), /公司制度3.md/u)
  assert.equal(result.summary.revenue, 30)
})
