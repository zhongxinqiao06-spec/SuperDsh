import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  inspectSpreadsheetInputs,
  generateOfficeWorkbook,
} from '../agents/office/generic-spreadsheet.ts'
import { createSalesWorkbookTemplate } from '../agents/office/spreadsheet.ts'
import { createDemoAssets } from '../agents/office/samples.ts'
import {
  inspectOfficePresentationTemplate,
  generateOfficePresentation,
} from '../agents/office/generic-presentation.ts'
import {
  decodeOfficeToolResult,
  officeFixtureCompanyTemplate,
  officeFixturePlan,
  officeReviewAction,
} from './support/office-runtime-model.mjs'

test('real Host fixture decodes native text and wrapped tool results', () => {
  const result = { inspection: { tables: [] }, sources: [] }
  assert.deepEqual(
    decodeOfficeToolResult([{ type: 'text', text: JSON.stringify(result) }]),
    result,
  )
  assert.deepEqual(
    decodeOfficeToolResult(JSON.stringify({ result: JSON.stringify(result) })),
    result,
  )
  assert.throws(() => decodeOfficeToolResult('tool failed'))
})

test('real Host spreadsheet plans compute uploaded and restarted attachment values with editable formulas', async () => {
  for (const [rows, expected] of [
    [
      'NEW-1,2026-10-01,华东,产品甲,2,100,40\nNEW-2,2026-10-02,华南,产品乙,3,20,10',
      260,
    ],
    ['CHAT-1,2026-10-14,华南,新上传附件,3,259,110', 777],
  ]) {
    const inputs = [
      {
        filename: '用户选择.csv',
        content: Buffer.from(
          `orderId,date,region,product,quantity,unitPrice,unitCost\n${rows}`,
        ),
      },
    ]
    const inspection = await inspectSpreadsheetInputs(inputs)
    const plan = officeFixturePlan('spreadsheet_report', { inspection })
    const template =
      expected === 260 ? await createSalesWorkbookTemplate() : undefined
    const generated = await generateOfficeWorkbook({ inputs, plan, template })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(generated.content)
    assert.equal(workbook.title, '配置中心默认标题')
    assert.equal(
      workbook.getWorksheet('现场经营汇总').getCell('A2').value,
      expected,
    )
    assert.match(
      workbook.getWorksheet('现场销售明细').getCell('H2').formula,
      /E2\*F2/,
    )
    assert.ok(
      (await JSZip.loadAsync(generated.content)).file(
        /^xl\/charts\/chart\d+\.xml$/,
      ).length,
    )
  }
})

test('real Host PPT plan maps inspected regions without placeholder strings and keeps native chart/table', async () => {
  const template = await officeFixtureCompanyTemplate()
  const sources = [
    {
      id: 'uploaded-sales',
      filename: '现场新销售.csv',
      text: 'NEW-1,2,100\nNEW-2,3,20',
    },
  ]
  const inspection = {
    template: await inspectOfficePresentationTemplate(template),
    sources,
  }
  const plan = officeFixturePlan('presentation_report', { inspection })
  const output = await generateOfficePresentation({ plan, template, sources })
  assert.equal(output.pages.length, 5)
  const archive = await JSZip.loadAsync(output.content)
  assert.ok(archive.file(/^ppt\/charts\/chart\d+\.xml$/).length)
  const slides = (
    await Promise.all(
      archive
        .file(/^ppt\/slides\/slide\d+\.xml$/)
        .map((entry) => entry.async('string')),
    )
  ).join('\n')
  assert.match(slides, /<a:tbl>/)
  assert.match(slides, /脱敏企业 · 内部资料/)
  assert.doesNotMatch(slides, /企业模板标题|企业模板正文/)
})

test('browser fixture groups the 100-row example before creating an editable chart', async () => {
  const assets = await createDemoAssets()
  const inputs = [assets.sales]
  const plan = officeFixturePlan('spreadsheet_report', {
    inspection: await inspectSpreadsheetInputs(inputs),
  })
  const output = await generateOfficeWorkbook({
    inputs,
    plan,
    template: assets.workbookTemplate,
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(output.content)
  assert.equal(workbook.getWorksheet('现场销售明细').rowCount, 101)
  assert.equal(workbook.getWorksheet('现场区域图表').rowCount, 5)
  assert.ok(
    (await JSZip.loadAsync(output.content)).file(/^xl\/charts\/chart\d+\.xml$/)
      .length,
  )
})

test('real Host notice helper submits only the declared plan confirmation option', () => {
  const notice = {
    status: 'open',
    interactionType: 'input_request',
    actions: [
      {
        actionId: 'submit',
        input: {
          uiSchema: {
            component: 'inputRequest',
            version: 1,
            questions: [
              {
                id: 'plan_1',
                prompt: '输入资料：用户上传.csv',
                intent: { kind: 'plan-review', approveOptionId: 'approve' },
                options: [
                  { id: 'approve', label: '确认生成' },
                  { id: 'edit', label: '修改方案' },
                ],
              },
            ],
          },
        },
      },
    ],
  }
  assert.deepEqual(officeReviewAction(notice), {
    planId: 'plan_1',
    body: {
      actionId: 'submit',
      input: { answers: { plan_1: { optionIds: ['approve'] } } },
    },
  })
  assert.equal(officeReviewAction({ ...notice, status: 'resolved' }), null)
  const malformed = structuredClone(notice)
  malformed.actions[0].input.uiSchema.questions[0].intent.approveOptionId =
    'missing'
  assert.throws(() => officeReviewAction(malformed))
})
