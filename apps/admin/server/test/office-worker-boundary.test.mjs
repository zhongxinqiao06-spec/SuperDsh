import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { officeWork } from '../agents/office-worker-client.ts'

const freshSignal = () => new AbortController().signal
const source = (id, filename, content, role = 'input') => ({
  reference: {
    id,
    kind: 'attachment',
    role,
    name: filename,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length,
  },
  file: { filename, content },
})
const expenses = () => [
  source(
    'expenses',
    '脱敏费用.csv',
    Buffer.from('部门,金额\n销售,0.1\n销售,0.2'),
  ),
]
const expensePlan = () => ({
  title: '费用合计',
  filename: '费用合计.xlsx',
  sheets: [
    {
      name: '汇总',
      source: '0:CSV',
      operations: [
        { type: 'convert', column: '金额', to: 'number' },
        {
          type: 'group',
          by: ['部门'],
          aggregates: [{ column: '金额', operation: 'sum', as: '总额' }],
        },
      ],
    },
  ],
})

test('real PPT inspection crosses the worker boundary with only public template metadata and more than three sources', async () => {
  const ppt = new PptxGenJS()
  ppt.layout = 'LAYOUT_WIDE'
  for (const title of ['公司介绍', '服务与团队'])
    ppt
      .addSlide()
      .addText(title, { x: 1, y: 1, w: 8, h: 1, objectName: '品牌标题' })
  const template = source(
    'template',
    '脱敏公司模板.pptx',
    Buffer.from(await ppt.write({ outputType: 'nodebuffer' })),
    'template',
  )
  const documents = Array.from({ length: 4 }, (_, index) =>
    source(
      `source${index}`,
      `公司资料${index + 1}.txt`,
      Buffer.from(`公司资料 ${index + 1}\n这是经授权上传的脱敏资料。`),
      'knowledge',
    ),
  )
  const result = await officeWork(
    'inspect',
    'presentation_report',
    [...documents, template],
    null,
    freshSignal(),
  )
  assert.equal(result.sources.length, 4)
  assert.equal(result.template.slides.length, 2)
  assert.equal(result.template.slides[1].shapes[0].text, '服务与团队')
  assert.ok(result.template.width > result.template.height)
  assert.equal('archive' in result.template, false)
  assert.deepEqual(structuredClone(result), result)
})

test('PPT preparation returns a plain reviewable plan and diagnostics without an artifact payload', async () => {
  const document = {
    title: '公司介绍',
    audience: '潜在客户',
    purpose: '介绍服务',
    slides: [
      {
        id: 'opening',
        kind: 'title',
        title: '脱敏公司介绍',
        body: ['这是用户明确要求的新建演示文稿。'],
      },
    ],
  }
  const result = await officeWork(
    'prepare',
    'presentation_report',
    [],
    document,
    freshSignal(),
  )
  assert.equal(result.document.slides[0].title, '脱敏公司介绍')
  assert.ok(Array.isArray(result.preflight.diagnostics))
  assert.equal('content' in result, false)
  assert.deepEqual(structuredClone(result), result)
})

test('spreadsheet inspection reports total size while sending only bounded sample rows through IPC', async () => {
  const content = Buffer.from(
    `员工,费用\n${Array.from({ length: 30 }, (_, index) => `员工${index},${index}`).join('\n')}`,
  )
  const result = await officeWork(
    'inspect',
    'spreadsheet_report',
    [source('data', '培训费用.csv', content)],
    null,
    freshSignal(),
  )
  assert.equal(result.tables[0].totalRows, 30)
  assert.equal(result.tables[0].rows.length, 12)
  assert.equal(result.tables[0].rowNumbers.length, 12)
  assert.deepEqual(result.tables[0].columns, ['员工', '费用'])
})

test('spreadsheet bytes survive worker transport and contain independently readable exact totals', async () => {
  const artifact = await officeWork(
    'generate',
    'spreadsheet_report',
    expenses(),
    expensePlan(),
    freshSignal(),
  )
  assert.equal(artifact.filename, '费用合计.xlsx')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(artifact.content))
  assert.equal(workbook.getWorksheet('汇总').getCell('B2').value, 0.3)
  assert.ok(workbook.getWorksheet('来源与异常'))
})

test('an unsupported input produces a diagnostic validation failure rather than a cancellation', async () => {
  await assert.rejects(
    officeWork(
      'prepare',
      'spreadsheet_report',
      expenses(),
      { ...expensePlan(), execute: 'arbitrary code' },
      freshSignal(),
    ),
    (error) =>
      error.status === 422 &&
      /不支持|未知/u.test(error.message) &&
      !error.message.includes('取消'),
  )
})

test('a pre-cancelled request retains its actual abort reason without beginning work', async () => {
  const controller = new AbortController()
  const reason = new Error('用户已离开当前任务')
  controller.abort(reason)
  await assert.rejects(
    officeWork(
      'inspect',
      'spreadsheet_report',
      expenses(),
      null,
      controller.signal,
    ),
    (error) => error === reason,
  )
})

test('cancelling an active worker reports cancellation and does not cancel a subsequent task', async () => {
  const controller = new AbortController()
  const pending = officeWork(
    'generate',
    'spreadsheet_report',
    expenses(),
    expensePlan(),
    controller.signal,
  )
  const checked = assert.rejects(
    pending,
    (error) => error.status === 499 && error.message.includes('取消'),
  )
  controller.abort()
  await checked
  const next = await officeWork(
    'inspect',
    'spreadsheet_report',
    expenses(),
    null,
    freshSignal(),
  )
  assert.equal(next.tables[0].totalRows, 2)
})

test('an expired worker deadline is a timeout, never a user cancellation, and releases the worker', async (t) => {
  // Advance the real client deadline only; the actual worker and its IPC are unmocked.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const pending = officeWork(
    'generate',
    'spreadsheet_report',
    expenses(),
    expensePlan(),
    controller.signal,
  )
  const checked = assert.rejects(
    pending,
    (error) =>
      error.status === 504 &&
      error.message.includes('超时') &&
      !error.message.includes('取消'),
  )
  t.mock.timers.tick(85_000)
  await checked
  assert.equal(controller.signal.aborted, false)
  t.mock.timers.reset()
  const next = await officeWork(
    'inspect',
    'spreadsheet_report',
    expenses(),
    null,
    freshSignal(),
  )
  assert.equal(next.tables[0].totalRows, 2)
})
