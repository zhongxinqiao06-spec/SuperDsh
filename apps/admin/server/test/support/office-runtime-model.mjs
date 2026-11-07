import assert from 'node:assert/strict'
import PptxGenJS from 'pptxgenjs'

export async function officeFixtureCompanyTemplate() {
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  const slide = deck.addSlide()
  slide.addText('企业模板标题', {
    x: 0.7,
    y: 0.5,
    w: 11.8,
    h: 0.85,
    fontSize: 30,
    fontFace: 'Microsoft YaHei',
    objectName: '企业标题',
  })
  slide.addText('企业模板正文', {
    x: 0.7,
    y: 1.7,
    w: 11.8,
    h: 4.5,
    fontSize: 21,
    fontFace: 'Microsoft YaHei',
    objectName: '企业正文',
  })
  slide.addText('脱敏企业 · 内部资料', {
    x: 0.7,
    y: 6.8,
    w: 11.8,
    h: 0.3,
    fontSize: 11,
    objectName: '企业页脚',
  })
  return {
    filename: '无占位符企业模板.pptx',
    content: Buffer.from(await deck.write({ outputType: 'nodebuffer' })),
  }
}

// This deterministic model emits the same public tool arguments as a real model.
// It never approves a plan or supplies Host-only confirmation credentials.
export function decodeOfficeToolResult(content) {
  const value = Array.isArray(content)
    ? content.map((item) => item.text ?? '').join('\n')
    : content
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return parsed?.result ? decodeOfficeToolResult(parsed.result) : parsed
}

export function officeFixturePlan(tool, result) {
  assert.ok(result.inspection, 'plan must follow the real inspect response')
  if (tool === 'illustration_render')
    return {
      title: '公司资料处理流程',
      layout: 'flow',
      nodes: [
        { id: 'input', title: '确认资料', detail: '核对来源和可使用范围。' },
        { id: 'plan', title: '策划方案', detail: '确认受众、结构和交付要求。' },
        { id: 'check', title: '校验交付', detail: '保留来源与可编辑原文件。' },
      ],
    }
  if (result.inspection.images?.length) {
    const imageId = result.inspection.images[0].id
    assert.ok(imageId, 'image ID must come from authorized inspect response')
    if (tool === 'document_report')
      return {
        title: '公司流程手册',
        sections: [
          {
            id: 'flow',
            title: '资料交付流程',
            blocks: [
              {
                type: 'paragraph',
                text: '这张配图由已确认的结构化方案绘制，使用本会话成果。',
              },
              { type: 'image', imageId, caption: '从资料确认到可靠交付' },
            ],
          },
        ],
      }
    assert.equal(tool, 'presentation_report')
    return {
      title: '公司流程介绍',
      slides: [
        { id: 'flow', kind: 'image', title: '从企业资料到可靠交付', imageId },
      ],
    }
  }
  if (tool === 'spreadsheet_report') {
    const table = result.inspection.tables[0]
    assert.ok(table?.columns.includes('unitPrice'))
    const calculations = [
      { type: 'convert', column: 'quantity', to: 'number' },
      { type: 'convert', column: 'unitPrice', to: 'number' },
      {
        type: 'formula',
        column: '销售额',
        expression: {
          op: '*',
          left: { column: 'quantity' },
          right: { column: 'unitPrice' },
        },
        numberFormat: '#,##0.00',
      },
    ]
    return {
      title: '配置中心默认标题',
      filename: '用户资料经营分析.xlsx',
      sheets: [
        {
          name: '现场销售明细',
          source: table.id,
          operations: calculations,
        },
        {
          name: '现场经营汇总',
          source: table.id,
          operations: [
            ...calculations,
            {
              type: 'group',
              by: [],
              aggregates: [
                { column: '销售额', as: '销售总额', operation: 'sum' },
              ],
            },
          ],
        },
        {
          name: '现场区域图表',
          source: table.id,
          operations: [
            ...calculations,
            {
              type: 'group',
              by: ['region'],
              aggregates: [
                { column: '销售额', as: '销售额', operation: 'sum' },
              ],
            },
          ],
          charts: [
            {
              type: 'column',
              title: '区域销售额',
              category: 'region',
              values: ['销售额'],
            },
          ],
        },
      ],
    }
  }
  assert.equal(tool, 'presentation_report')
  const source = result.inspection.sources[0]
  const templatePage = result.inspection.template.slides[0]
  assert.ok(source?.text.includes('NEW-1'))
  const titleShape = templatePage.shapes.find(
    (shape) => shape.name === '企业标题',
  )
  const bodyShape = templatePage.shapes.find(
    (shape) => shape.name === '企业正文',
  )
  assert.ok(
    titleShape && bodyShape,
    'use inspected company regions, not placeholder text',
  )
  const template = {
    slide: templatePage.number,
    titleShape: titleShape.name,
    bodyShape: bodyShape.name,
  }
  const common = { template, sourceIds: [source.id] }
  return {
    title: '配置中心默认标题',
    audience: '脱敏示例公司的经营团队',
    purpose: '呈现用户明确选择的订单资料和行动建议',
    brand: { company: '配置中心公司名', accentColor: '183B56' },
    slides: [
      {
        ...common,
        id: 'cover',
        kind: 'title',
        title: '配置中心默认标题',
        body: ['配置中心公司名', '基于现场新销售.csv 的经营汇报'],
      },
      {
        ...common,
        id: 'method',
        kind: 'content',
        title: '资料与计算口径',
        body: [
          '使用现场上传的两条订单明细。',
          '销售额按数量乘以单价计算；本次资料均采用同一币种。',
        ],
      },
      {
        ...common,
        id: 'detail',
        kind: 'table',
        title: '订单明细',
        table: {
          columns: ['订单', '数量', '单价'],
          rows: [
            ['NEW-1', 2, 100],
            ['NEW-2', 3, 20],
          ],
        },
      },
      {
        ...common,
        id: 'chart',
        kind: 'chart',
        title: '订单数量',
        chart: {
          type: 'bar',
          categories: ['NEW-1', 'NEW-2'],
          series: [{ name: '数量', values: [2, 3] }],
          valueUnit: '件',
        },
      },
      {
        ...common,
        id: 'actions',
        kind: 'content',
        title: '后续行动',
        body: ['复核订单回款状态。', '补齐退货与费用资料后再分析净收益。'],
      },
    ],
  }
}

export function officeReviewAction(notice) {
  if (notice.status !== 'open' || notice.interactionType !== 'input_request')
    return null
  const action = notice.actions.find(
    (item) => item.input?.uiSchema?.component === 'inputRequest',
  )
  const questions = action?.input.uiSchema.questions
  if (!questions?.some((question) => question.intent?.kind === 'plan-review'))
    return null
  assert.equal(questions.length, 1)
  const [question] = questions
  const option = question.options.find(
    (item) => item.id === question.intent.approveOptionId,
  )
  assert.equal(option?.label, '确认生成')
  assert.ok((question.detail || question.prompt).includes('输入资料'))
  return {
    planId: question.id,
    body: {
      actionId: action.actionId,
      input: { answers: { [question.id]: { optionIds: [option.id] } } },
    },
  }
}
