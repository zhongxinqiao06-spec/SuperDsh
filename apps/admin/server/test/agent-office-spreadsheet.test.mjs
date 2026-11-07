import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  generateOfficeWorkbook,
  inspectSpreadsheetInputs,
  prepareOfficeSpreadsheet,
  validateOfficeSpreadsheetPlan,
} from '../agents/office/generic-spreadsheet.ts'
import { ExactDecimal } from '../agents/office/formula.ts'

const csv = (text, filename = '脱敏数据.csv') => ({
  filename,
  content: Buffer.from(text),
})
const xlsx = async (configure, filename = '脱敏数据.xlsx') => {
  const workbook = new ExcelJS.Workbook()
  configure(workbook)
  return { filename, content: Buffer.from(await workbook.xlsx.writeBuffer()) }
}
const plan = (operations = [], other = {}) => ({
  title: '办公处理',
  sheets: [{ name: '结果', source: '0:CSV', operations }],
  ...other,
})
const prepare = (text, operations = [], overrides = {}) =>
  prepareOfficeSpreadsheet({
    inputs: [csv(text)],
    plan: plan(operations, overrides),
  })
const workbookOf = async (artifact) => {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(artifact.content)
  return workbook
}
const column = (name) => ({ column: name })
const literal = (value) => ({ literal: value })
const op = (operator, left, right) => ({ op: operator, left, right })

test('01: independent sheets and physical header rows are discoverable and mappable', async () => {
  const file = await xlsx((workbook) => {
    const costs = workbook.addWorksheet('费用')
    costs.addRow(['脱敏费用明细'])
    costs.addRow(['员工', '金额'])
    costs.addRow(['李甲', 12.5])
    const training = workbook.addWorksheet('培训')
    training.addRow(['课程', '人数'])
    training.addRow(['安全', 8])
  })
  const result = await inspectSpreadsheetInputs([file])
  assert.deepEqual(
    result.tables.map((table) => [table.id, table.headerRow, table.rows]),
    [
      ['0:费用', 2, [['李甲', 12.5]]],
      ['0:培训', 1, [['安全', 8]]],
    ],
  )
  const mapped = await inspectSpreadsheetInputs([file], {
    selections: [
      {
        fileIndex: 0,
        sheet: '费用',
        headerRow: 2,
        mapping: { 员工: 'employee', 金额: 'amount' },
      },
    ],
  })
  assert.deepEqual(mapped.tables[0].columns, ['employee', 'amount'])
})

test('02: sales accepts line items, returns and absent cost without inventing profit', async () => {
  const result = await prepare(
    '订单,数量,单价\nA1,2,10.1\nA1,3,5\nA2,-1,10.1',
    [
      {
        type: 'formula',
        column: '收入',
        expression: op('*', column('数量'), column('单价')),
      },
      {
        type: 'group',
        by: [],
        aggregates: [
          { column: '订单', as: '订单数', operation: 'countDistinct' },
          { column: '订单', as: '明细行', operation: 'count' },
          { column: '收入', as: '收入', operation: 'sum' },
        ],
      },
    ],
  )
  assert.deepEqual(result.tables[0].rows, [[2, 3, 25.1]])
  assert.ok(!result.tables[0].columns.includes('利润'))
})

test('03: concatenation aligns mapped fields across several files rather than positions', async () => {
  const result = await prepareOfficeSpreadsheet({
    inputs: [
      csv('部门,费用\n销售,0.1'),
      csv('amount,department\n0.2,销售', '另月.csv'),
    ],
    plan: plan(
      [
        { type: 'concat', tables: ['1:CSV'] },
        {
          type: 'group',
          by: ['部门'],
          aggregates: [{ column: '费用', as: '费用合计', operation: 'sum' }],
        },
      ],
      {
        sources: [
          { fileIndex: 0 },
          { fileIndex: 1, mapping: { amount: '费用', department: '部门' } },
        ],
      },
    ),
  })
  assert.deepEqual(result.tables[0].rows, [['销售', 0.3]])
  assert.equal(result.sources.length, 2)
})

test('04: clean, deduplicate, filter and sort records with source-row diagnostics', async () => {
  const result = await prepare(
    '员工,金额\n 李甲 ,30\n李甲,30\n赵乙,5\n周丙,20',
    [
      { type: 'trim', columns: ['员工'] },
      { type: 'convert', column: '金额', to: 'number' },
      { type: 'dedup', columns: ['员工', '金额'] },
      {
        type: 'filter',
        conditions: [{ column: '金额', operator: 'gte', value: 10 }],
      },
      { type: 'sort', by: [{ column: '金额', direction: 'asc' }] },
    ],
  )
  assert.deepEqual(result.tables[0].rows, [
    ['周丙', 20],
    ['李甲', 30],
  ])
  assert.equal(
    result.issues.find((issue) => issue.code === 'duplicate-removed').row,
    3,
  )
})

test('05: joins support one-to-many records and report unmatched rows', async () => {
  const result = await prepareOfficeSpreadsheet({
    inputs: [
      csv('订单,客户\nA1,甲\nA2,乙'),
      csv('编号,商品\nA1,电脑\nA1,键盘', '商品.csv'),
    ],
    plan: plan([
      {
        type: 'join',
        table: '1:CSV',
        leftKey: '订单',
        rightKey: '编号',
        how: 'left',
        columns: { 商品: '明细商品' },
      },
    ]),
  })
  assert.deepEqual(result.tables[0].rows, [
    ['A1', '甲', '电脑'],
    ['A1', '甲', '键盘'],
    ['A2', '乙', null],
  ])
  assert.ok(result.issues.some((issue) => issue.code === 'unmatched-join'))
})

test('06: exact decimals distinguish arithmetic from binary floating-point and round halves away from zero', async () => {
  assert.equal(ExactDecimal.from(0.1).add(ExactDecimal.from(0.2)).number(), 0.3)
  assert.equal(ExactDecimal.from(-1.005).round(2).number(), -1.01)
  const result = await prepare('部门,费用\n行政,1.005\n行政,2.005', [
    {
      type: 'group',
      by: ['部门'],
      aggregates: [
        { column: '费用', as: '总额', operation: 'sum' },
        { column: '费用', as: '平均', operation: 'average' },
      ],
    },
  ])
  assert.deepEqual(result.tables[0].rows, [['行政', 3.01, 1.505]])
})

test('07: mixed currencies require an explicit currency grouping', async () => {
  const text = '部门,币种,金额\n研发,CNY,10\n研发,USD,20'
  const aggregate = { column: '金额', as: '合计', operation: 'sum' }
  await assert.rejects(
    prepare(text, [{ type: 'group', by: ['部门'], aggregates: [aggregate] }]),
    /多个币种/u,
  )
  const result = await prepare(text, [
    { type: 'group', by: ['部门', '币种'], aggregates: [aggregate] },
  ])
  assert.deepEqual(result.tables[0].rows, [
    ['研发', 'CNY', 10],
    ['研发', 'USD', 20],
  ])
})

test('08: training crosstab aggregates by department and course', async () => {
  const result = await prepare(
    '部门,课程,人数\n销售,合规,3\n销售,安全,2\n销售,安全,5\n研发,安全,4',
    [
      {
        type: 'pivot',
        rows: ['部门'],
        columns: '课程',
        value: '人数',
        operation: 'sum',
      },
    ],
  )
  assert.deepEqual(result.tables[0].columns, ['部门', '合规', '安全'])
  assert.deepEqual(result.tables[0].rows, [
    ['销售', 3, 7],
    ['研发', 0, 4],
  ])
})

test('09: generated formulas remain editable and their caches match independent calculations', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [csv('数量,单价\n3,0.1\n2,19.9')],
    plan: plan([
      {
        type: 'formula',
        column: '金额',
        expression: {
          fn: 'ROUND',
          args: [op('*', column('数量'), column('单价')), literal(2)],
        },
        numberFormat: '#,##0.00',
      },
      {
        type: 'formula',
        column: '大单总额',
        expression: {
          aggregate: 'sum',
          column: '金额',
          where: { column: '金额', operator: 'gt', value: 1 },
        },
      },
    ]),
  })
  const result = (await workbookOf(artifact)).getWorksheet('结果')
  assert.equal(result.getCell('C2').formula, 'ROUND((A2*B2),2)')
  assert.equal(result.getCell('C2').result, 0.3)
  assert.equal(result.getCell('C3').result, 39.8)
  assert.equal(result.getCell('D2').result, 39.8)
  assert.match(result.getCell('D2').formula, /^SUMIF\(/u)
  assert.equal(artifact.provenance[0].sha256.length, 64)
})

test('10: conditional, string and date functions are deterministic and IF is lazy', async () => {
  const result = await prepare('日期,状态\n2026-10-01, 已完成 ', [
    {
      type: 'formula',
      column: '月',
      expression: { fn: 'MONTH', args: [column('日期')] },
    },
    {
      type: 'formula',
      column: '天数',
      expression: { fn: 'DAYS', args: [literal('2026-10-17'), column('日期')] },
    },
    {
      type: 'formula',
      column: '说明',
      expression: { fn: 'TRIM', args: [column('状态')] },
    },
    {
      type: 'formula',
      column: '安全条件',
      expression: {
        fn: 'IF',
        args: [
          literal(false),
          op('/', literal(1), literal(0)),
          literal('不计算'),
        ],
      },
    },
  ])
  assert.deepEqual(result.tables[0].rows[0].slice(2), [
    10,
    16,
    '已完成',
    '不计算',
  ])
})

test('11: lookup resolves another source table with explicit missing result and live formulas', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [csv('工号\nE1\nE2'), csv('编号,部门\nE1,销售', '员工.csv')],
    plan: plan([
      {
        type: 'formula',
        column: '部门',
        expression: {
          lookup: {
            table: '1:CSV',
            keyColumn: '编号',
            value: column('工号'),
            returnColumn: '部门',
            missing: '未维护',
          },
        },
      },
    ]),
  })
  const sheet = (await workbookOf(artifact)).getWorksheet('结果')
  assert.equal(sheet.getCell('B2').result, '销售')
  assert.equal(sheet.getCell('B3').result, '未维护')
  assert.match(sheet.getCell('B2').formula, /'数据2_CSV'/u)
})

test('12: new workbook from confirmed explicit data does not require a demo sales file', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [],
    plan: {
      title: '项目计划',
      sheets: [
        {
          name: '行动项',
          source: {
            columns: ['任务', '负责人', '完成日期'],
            rows: [['安全培训', '李甲', '2026-11-01']],
          },
        },
      ],
    },
  })
  assert.deepEqual(artifact.provenance, [])
  assert.equal(
    (await workbookOf(artifact)).getWorksheet('行动项').getCell('A2').value,
    '安全培训',
  )
})

test('13: an ordinary workbook template retains supported formulas, branding and styles', async () => {
  const template = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('预算')
    sheet.getCell('A1').value = '星河有限公司（脱敏）'
    sheet.getCell('A1').font = { bold: true, color: { argb: 'FF123456' } }
    sheet.getCell('B1').value = 0.1
    sheet.getCell('B2').value = 0.2
    sheet.getCell('B3').value = { formula: 'SUM(B1:B2)', result: 999 }
  }, '公司模板.xlsx')
  const artifact = await generateOfficeWorkbook({
    inputs: [csv('任务,人数\n安全,8')],
    plan: plan(),
    template,
  })
  const sheet = (await workbookOf(artifact)).getWorksheet('预算')
  assert.equal(sheet.getCell('A1').font.color.argb, 'FF123456')
  assert.equal(sheet.getCell('B3').formula, 'SUM(B1:B2)')
  assert.equal(sheet.getCell('B3').result, 0.3)
})

test('14: imported formulas are recalculated, preserved with styling, and cross-sheet references are remapped', async () => {
  const file = await xlsx((workbook) => {
    const data = workbook.addWorksheet('原数据')
    data.addRow(['项', '金额'])
    data.addRow(['甲', 0.1])
    data.addRow(['乙', 0.2])
    const summary = workbook.addWorksheet('汇总')
    summary.addRow(['项', '金额'])
    summary.addRow(['合计', { formula: "SUM('原数据'!B2:B3)", result: 888 }])
    summary.getCell('B2').numFmt = '0.00'
  })
  const artifact = await generateOfficeWorkbook({
    inputs: [file],
    plan: { title: '汇总', sheets: [{ name: '输出', source: '0:汇总' }] },
  })
  const workbook = await workbookOf(artifact)
  assert.equal(workbook.getWorksheet('输出').getCell('B2').value, 0.3)
  assert.equal(
    workbook.getWorksheet('原始1_汇总').getCell('B2').formula,
    "SUM('原始1_原数据'!B2:B3)",
  )
  assert.equal(workbook.getWorksheet('原始1_汇总').getCell('B2').numFmt, '0.00')
})

test('15: unsupported formulas fail preflight rather than silently retain unverified cached results', async () => {
  const file = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('数据')
    sheet.addRow(['项', '结果'])
    sheet.addRow([
      '甲',
      { formula: 'WEBSERVICE("https://example.com")', result: 42 },
    ])
  })
  await assert.rejects(
    inspectSpreadsheetInputs([file]),
    /不支持原始公式函数 WEBSERVICE/u,
  )
})

test('16: missing inputs or columns never fall back to demonstration data', async () => {
  await assert.rejects(
    prepareOfficeSpreadsheet({ inputs: [], plan: plan() }),
    /找不到输入表/u,
  )
  await assert.rejects(
    prepare('员工,金额\n甲,5', [{ type: 'select', columns: ['成本'] }]),
    /缺少字段/u,
  )
})

test('17: untrusted formula code, extra commands and malformed schema are rejected', () => {
  assert.throws(
    () =>
      validateOfficeSpreadsheetPlan(
        plan([
          {
            type: 'formula',
            column: '恶意',
            expression: { script: 'process.exit()' },
          },
        ]),
      ),
    /未知字段/u,
  )
  assert.throws(
    () => validateOfficeSpreadsheetPlan(plan([], { command: 'calc.exe' })),
    /未知字段/u,
  )
  assert.throws(
    () =>
      validateOfficeSpreadsheetPlan(plan([], { filename: '../../报告.xlsx' })),
    /文件名/u,
  )
  assert.throws(
    () =>
      validateOfficeSpreadsheetPlan(
        plan([
          {
            type: 'formula',
            column: '计算',
            expression: { fn: 'IF', args: [literal(true)] },
          },
        ]),
      ),
    /参数数量/u,
  )
})

test('18: invalid conversions require an explicit policy and report cleared values', async () => {
  const text = '员工,报销金额\n甲,未知\n乙,12.5'
  await assert.rejects(
    prepare(text, [{ type: 'convert', column: '报销金额', to: 'number' }]),
    /第 2 行/u,
  )
  const result = await prepare(text, [
    { type: 'convert', column: '报销金额', to: 'number', onInvalid: 'blank' },
  ])
  assert.deepEqual(result.tables[0].rows, [
    ['甲', null],
    ['乙', 12.5],
  ])
  assert.equal(
    result.issues.find((issue) => issue.code === 'conversion-blank').column,
    '报销金额',
  )
})

test('19: cancelled preparation/generation stops before producing an artifact', async () => {
  const signal = AbortSignal.abort(new Error('用户取消'))
  await assert.rejects(
    generateOfficeWorkbook({
      inputs: [csv('姓名,金额\n甲,1')],
      plan: plan(),
      signal,
    }),
    /用户取消/u,
  )
})

test('20: native editable column, line and pie charts reference output cells with XML caches', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [],
    plan: {
      title: '费用图表',
      sheets: [
        {
          name: '费用',
          source: {
            columns: ['部门', '金额'],
            rows: [
              ['销售', 10],
              ['研发', 20],
            ],
          },
          charts: ['column', 'line', 'pie'].map((type) => ({
            type,
            title: '脱敏费用对比',
            category: '部门',
            values: ['金额'],
          })),
        },
      ],
    },
  })
  const archive = await JSZip.loadAsync(artifact.content)
  assert.equal(archive.file(/^xl\/charts\/chart\d+\.xml$/u).length, 3)
  const chart = await archive.file('xl/charts/chart1.xml').async('string')
  assert.match(chart, /c:barChart/u)
  assert.match(chart, /费用&apos;!\$B\$2:\$B\$3/u)
  assert.match(chart, /<c:v>20<\/c:v>/u)
  assert.match(
    await archive.file('xl/worksheets/sheet1.xml').async('string'),
    /rIdOfficeChart/u,
  )
  assert.match(
    await archive.file('xl/drawings/drawing1.xml').async('string'),
    /graphicFrame/u,
  )
})

test('21: unsupported input chart preservation requires explicit data-only approval', async () => {
  const charted = await generateOfficeWorkbook({
    inputs: [],
    plan: {
      title: '源图表',
      sheets: [
        {
          name: '数据',
          source: {
            columns: ['类别', '金额'],
            rows: [
              ['甲', 1],
              ['乙', 2],
            ],
          },
          charts: [
            {
              type: 'column',
              title: '分类金额',
              category: '类别',
              values: ['金额'],
            },
          ],
        },
      ],
    },
  })
  const p = {
    title: '复制数据',
    sources: [{ fileIndex: 0, sheet: '数据' }],
    sheets: [{ name: '结果', source: '0:数据' }],
  }
  await assert.rejects(
    prepareOfficeSpreadsheet({ inputs: [charted], plan: p }),
    /明确确认|确认仅提取/u,
  )
  const result = await prepareOfficeSpreadsheet({
    inputs: [charted],
    plan: { ...p, allowValueExtraction: true },
  })
  assert.ok(result.issues.some((issue) => issue.code === 'unsupported-visuals'))
})

test('22: circular input formulas and duplicate lookup keys cannot produce misleading results', async () => {
  const file = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('数据')
    sheet.addRow(['姓名', '数字'])
    sheet.addRow(['甲', { formula: 'B2+1', result: 1 }])
  })
  await assert.rejects(inspectSpreadsheetInputs([file]), /循环引用/u)
  await assert.rejects(
    prepareOfficeSpreadsheet({
      inputs: [csv('工号\nE1'), csv('编号,部门\nE1,销售\nE1,研发', '部门.csv')],
      plan: plan([
        {
          type: 'formula',
          column: '部门',
          expression: {
            lookup: {
              table: '1:CSV',
              keyColumn: '编号',
              value: column('工号'),
              returnColumn: '部门',
            },
          },
        },
      ]),
    }),
    /不唯一/u,
  )
})

test('23: malformed mappings, collisions, oversize joins and bad dates fail with actionable errors', async () => {
  await assert.rejects(
    inspectSpreadsheetInputs([csv('姓名,金额\n甲,5')], {
      selections: [{ fileIndex: 0, mapping: { 姓名: 'x', 金额: 'x' } }],
    }),
    /重复/u,
  )
  await assert.rejects(
    prepare('姓名,金额\n甲,5', [{ type: 'rename', columns: { 姓名: '金额' } }]),
    /重名/u,
  )
  await assert.rejects(
    prepare('日期,金额\n2026-02-30,5', [
      { type: 'convert', column: '日期', to: 'date' },
    ]),
    /日期无效/u,
  )
  const many = `键,值\n${Array.from({ length: 80 }, (_, i) => `A,${i}`).join('\n')}`
  await assert.rejects(
    prepareOfficeSpreadsheet({
      inputs: [csv(many), csv(many, '右表.csv')],
      plan: plan([
        {
          type: 'join',
          table: '1:CSV',
          leftKey: '键',
          rightKey: '键',
          how: 'inner',
          columns: { 值: '右值' },
        },
      ]),
    }),
    /超过 5000/u,
  )
})

test('24: raw original bytes remain unchanged and empty outputs are explicit', async () => {
  const input = csv('员工,金额\n甲,5'),
    before = Buffer.from(input.content)
  const artifact = await generateOfficeWorkbook({
    inputs: [input],
    plan: plan([
      {
        type: 'filter',
        conditions: [{ column: '金额', operator: 'gt', value: 100 }],
      },
    ]),
  })
  assert.deepEqual(input.content, before)
  assert.equal(artifact.sheets[0].rowCount, 0)
  assert.equal((await workbookOf(artifact)).getWorksheet('结果').rowCount, 1)
})

test('25: generated formula outputs can be uploaded again with recalculated results for revisions', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [
      csv('员工,金额,日期\nA*,1.5,2026-10-01\nE2,2.5,2026-10-02'),
      csv('工号,部门\nA*,销售\nE2,研发', '人事.csv'),
    ],
    plan: plan([
      { type: 'convert', column: '金额', to: 'number' },
      {
        type: 'formula',
        column: '条件合计',
        expression: {
          aggregate: 'sum',
          column: '金额',
          where: { column: '员工', operator: 'eq', value: 'A*' },
        },
      },
      {
        type: 'formula',
        column: '平均',
        expression: { aggregate: 'average', column: '金额' },
      },
      {
        type: 'formula',
        column: '月',
        expression: { fn: 'MONTH', args: [column('日期')] },
      },
      {
        type: 'formula',
        column: '部门',
        expression: {
          lookup: {
            table: '1:CSV',
            keyColumn: '工号',
            value: column('员工'),
            returnColumn: '部门',
          },
        },
      },
    ]),
  })
  const result = await inspectSpreadsheetInputs([artifact], {
    selections: [{ fileIndex: 0, sheet: '结果' }],
  })
  assert.deepEqual(result.tables[0].rows[0], [
    'A*',
    1.5,
    '2026-10-01',
    1.5,
    2,
    10,
    '销售',
  ])
  assert.deepEqual(result.tables[0].rows[1], [
    'E2',
    2.5,
    '2026-10-02',
    1.5,
    2,
    10,
    '研发',
  ])
})

test('26: CSV title and blank rows retain their physical row numbers', async () => {
  const result = await inspectSpreadsheetInputs(
    [csv('脱敏费用\n\n员工,金额\n甲,5\n\n乙,10')],
    { selections: [{ fileIndex: 0, headerRow: 3 }] },
  )
  assert.deepEqual(result.tables[0].rowNumbers, [4, 6])
  assert.equal(result.tables[0].headerRow, 3)
})

test('27: huge formula references fail before allocating rows or silently treating them as zero', async () => {
  const file = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('数据')
    sheet.addRow(['姓名', '结果'])
    sheet.addRow(['甲', { formula: 'SUM(A1:XFD1048576)', result: 0 }])
  })
  await assert.rejects(
    inspectSpreadsheetInputs([file]),
    /公式引用超出支持范围/u,
  )
})

test('28: formulas cannot sum text-formatted numeric data differently from Excel on opening', async () => {
  await assert.rejects(
    prepare('部门,费用\n甲,1.5', [
      {
        type: 'formula',
        column: '合计',
        expression: { aggregate: 'sum', column: '费用' },
      },
    ]),
    /先转换为数字/u,
  )
  const result = await prepare('部门,费用\n甲,1.5', [
    { type: 'convert', column: '费用', to: 'number' },
    {
      type: 'formula',
      column: '合计',
      expression: { aggregate: 'sum', column: '费用' },
    },
  ])
  assert.equal(result.tables[0].rows[0][2], 1.5)
})

test('29: formula aggregation cannot silently combine currencies', async () => {
  const inputs = [csv('部门,金额,币种\n甲,10,CNY\n乙,20,USD')]
  const operations = [
    { type: 'convert', column: '金额', to: 'number' },
    {
      type: 'formula',
      column: '合计',
      expression: { aggregate: 'sum', column: '金额' },
    },
  ]
  await assert.rejects(
    prepareOfficeSpreadsheet({ inputs, plan: plan(operations) }),
    /多个币种/u,
  )
  operations[1].expression.where = {
    column: '币种',
    operator: 'eq',
    value: 'CNY',
  }
  const result = await prepareOfficeSpreadsheet({
    inputs,
    plan: plan(operations),
  })
  assert.equal(result.tables[0].rows[0][3], 10)
})

test('30: empty filtered statistics remain blank when reopened instead of division errors or invented zeroes', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [csv('部门,金额\n甲,10')],
    plan: plan([
      { type: 'convert', column: '金额', to: 'number' },
      ...['average', 'min', 'max'].map((aggregate) => ({
        type: 'formula',
        column: aggregate,
        expression: {
          aggregate,
          column: '金额',
          where: { column: '部门', operator: 'eq', value: '不存在' },
        },
      })),
    ]),
  })
  const workbook = await workbookOf(artifact)
  for (const cell of ['C2', 'D2', 'E2'])
    assert.match(
      workbook.getWorksheet('结果').getCell(cell).formula,
      /^IF\(COUNTIFS/u,
    )
  const inspected = await inspectSpreadsheetInputs([artifact], {
    selections: [{ fileIndex: 0, sheet: '结果' }],
  })
  assert.deepEqual(inspected.tables[0].rows[0].slice(2), ['', '', ''])
})

test('31: conditional formulas use the same numeric and blank criteria before and after reopening', async () => {
  const artifact = await generateOfficeWorkbook({
    inputs: [csv('编号,金额\n01,2\n1,3\n,4')],
    plan: plan([
      { type: 'convert', column: '金额', to: 'number' },
      {
        type: 'formula',
        column: '编号1合计',
        expression: {
          aggregate: 'sum',
          column: '金额',
          where: { column: '编号', operator: 'eq', value: '01' },
        },
      },
      {
        type: 'formula',
        column: '空编号合计',
        expression: {
          aggregate: 'sum',
          column: '金额',
          where: { column: '编号', operator: 'empty', value: '忽略' },
        },
      },
    ]),
  })
  const loaded = await workbookOf(artifact)
  assert.equal(loaded.getWorksheet('结果').getCell('C2').result, 5)
  assert.equal(loaded.getWorksheet('结果').getCell('D2').result, 4)
  const result = await inspectSpreadsheetInputs([artifact], {
    selections: [{ fileIndex: 0, sheet: '结果' }],
  })
  assert.deepEqual(result.tables[0].rows[0].slice(2), [5, 4])
})

test('32: text truthiness cannot manufacture a conditional financial result', async () => {
  await assert.rejects(
    prepare('状态,金额\n否,10', [
      {
        type: 'formula',
        column: '有效',
        expression: {
          fn: 'IF',
          args: [column('状态'), literal(10), literal(0)],
        },
      },
    ]),
    /IF 条件/u,
  )
  const file = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('费用')
    sheet.addRow(['姓名', '结果'])
    sheet.addRow(['甲', { formula: 'IF("FALSE",10,0)', result: 10 }])
  })
  await assert.rejects(inspectSpreadsheetInputs([file]), /IF 文本条件/u)
})

test('33: imported aggregates distinguish literal numeric text, referenced text and empty-string counts', async () => {
  const file = await xlsx((workbook) => {
    const sheet = workbook.addWorksheet('计算')
    sheet.addRow([
      '姓名',
      '文本金额',
      '直接求和',
      '引用求和',
      '非空计数',
      '数字计数',
    ])
    sheet.addRow([
      '甲',
      '10',
      { formula: 'SUM("10",TRUE,2)', result: 0 },
      { formula: 'SUM(B2,2)', result: 0 },
      { formula: 'COUNTA("",B2)', result: 0 },
      { formula: 'COUNT("10","不是数字",TRUE)', result: 0 },
    ])
  })
  const result = await inspectSpreadsheetInputs([file])
  assert.deepEqual(result.tables[0].rows[0], ['甲', '10', 13, 2, 2, 2])
})

test('34: distinct order identifiers never collapse leading zeros through Excel COUNTIF coercion', async () => {
  await assert.rejects(
    prepare('订单,金额\n001,10\n1,20', [
      {
        type: 'formula',
        column: '订单数',
        expression: { aggregate: 'countDistinct', column: '订单' },
      },
    ]),
    /数字文本编号/u,
  )
  const result = await prepare('订单,金额\n001,10\n1,20', [
    {
      type: 'group',
      by: [],
      aggregates: [
        { column: '订单', operation: 'countDistinct', as: '订单数' },
      ],
    },
  ])
  assert.equal(result.tables[0].rows[0][0], 2)
})
