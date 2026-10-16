import ExcelJS from 'exceljs'
import { cents, parseSalesFile, readWorkbook, summarizeSales } from './sales.ts'
import {
  OfficeInputError,
  type OfficeArtifact,
  type OfficeInputFile,
  type SalesReportInput,
} from './types.ts'
import { textValue } from './validation.ts'

export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const workbookPlaceholders = [
  'title',
  'company',
  'period',
  'source',
  'orderCount',
  'units',
  'revenue',
  'cost',
  'profit',
  'grossMargin',
  'salesRows',
]
const dataHeaders = [
  '订单编号',
  '日期',
  '区域',
  '产品',
  '数量',
  '单价',
  '单位成本',
  '销售额',
  '成本',
  '毛利',
]

export async function inspectWorkbookTemplate(file: OfficeInputFile) {
  const workbook = await readWorkbook(file)
  const placeholders = new Set<string>()
  let anchor: { sheet: ExcelJS.Worksheet; row: number } | undefined
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (
          cell.type === ExcelJS.ValueType.Formula ||
          cell.type === ExcelJS.ValueType.Error
        ) {
          throw new OfficeInputError(
            '演示版 Excel 模板只支持文本占位符和样式，请移除原有公式或错误值',
          )
        }
        if (typeof cell.value !== 'string') return
        const tokens = Array.from(
          cell.value.matchAll(/\{\{([^{}]+)\}\}/gu),
          (match) => match[1]!,
        )
        if (!tokens.length && /\{\{|\}\}/u.test(cell.value))
          throw new OfficeInputError('Excel 模板占位符未闭合')
        for (const token of tokens) {
          if (!workbookPlaceholders.includes(token))
            throw new OfficeInputError(`不支持的 Excel 占位符：{{${token}}}`)
          placeholders.add(token)
          if (
            !['title', 'company', 'period', 'source'].includes(token) &&
            cell.value !== `{{${token}}}`
          ) {
            throw new OfficeInputError(`数值占位符 {{${token}}} 必须独占单元格`)
          }
          if (token === 'salesRows') {
            if (
              anchor ||
              Number(cell.col) !== 1 ||
              Number(cell.row) < 2 ||
              Number(cell.row) > 10 ||
              cell.isMerged
            ) {
              throw new OfficeInputError(
                '{{salesRows}} 必须唯一，位于明细表 A2–A10 的未合并单元格',
              )
            }
            anchor = { sheet, row: Number(cell.row) }
          }
        }
      }),
    ),
  )
  if (!anchor)
    throw new OfficeInputError('Excel 模板缺少 {{salesRows}} 明细填充位置')
  const dataAnchor: { sheet: ExcelJS.Worksheet; row: number } = anchor
  for (const token of ['revenue', 'cost', 'profit', 'orderCount']) {
    if (!placeholders.has(token))
      throw new OfficeInputError(`Excel 模板缺少 {{${token}}}`)
  }
  dataAnchor.sheet.eachRow((row, rowNumber) => {
    if (rowNumber < dataAnchor.row) return
    row.eachCell((cell) => {
      if (
        cell.isMerged ||
        (cell.value !== null && cell.value !== '{{salesRows}}')
      ) {
        throw new OfficeInputError(
          '明细填充位置及其下方必须为空，且不能包含合并单元格',
        )
      }
    })
  })
  return { workbook, anchor: dataAnchor, placeholders: [...placeholders] }
}

export async function createSalesWorkbookTemplate(): Promise<OfficeArtifact> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SuperDsh'
  const summary = workbook.addWorksheet('经营汇总', {
    views: [{ showGridLines: false }],
  })
  summary.columns = [{ width: 24 }, { width: 62 }]
  summary.getCell('A1').value = '{{title}}'
  summary.mergeCells('A1:B1')
  summary.getRow(1).height = 34
  summary.getCell('A1').font = {
    name: 'Microsoft YaHei',
    size: 20,
    bold: true,
    color: { argb: 'FF183B56' },
  }
  const fields = [
    ['公司', '{{company}}'],
    ['统计期间', '{{period}}'],
    ['订单数', '{{orderCount}}'],
    ['销售件数', '{{units}}'],
    ['销售额（元）', '{{revenue}}'],
    ['成本（元）', '{{cost}}'],
    ['毛利（元）', '{{profit}}'],
    ['毛利率', '{{grossMargin}}'],
    ['数据来源', '{{source}}'],
  ]
  fields.forEach((values, index) => {
    const row = summary.getRow(index + 3)
    row.values = values
    row.height = 26
    row.font = { name: 'Microsoft YaHei', size: 11 }
    row.getCell(1).font = {
      name: 'Microsoft YaHei',
      size: 11,
      bold: true,
      color: { argb: 'FF183B56' },
    }
    row.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEAF0F5' },
    }
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' }
  })
  summary.getRow(12).height = 42
  summary.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
  }
  summary.pageSetup.printArea = 'A1:B12'
  const detail = workbook.addWorksheet('销售明细', {
    views: [{ state: 'frozen', ySplit: 2 }],
  })
  detail.columns = dataHeaders.map((name, i) => ({
    key: name,
    width: i === 0 || i === 3 ? 22 : 16,
  }))
  detail.getCell('A1').value = '原始订单和计算明细（元）'
  detail.getCell('A1').font = { name: 'Microsoft YaHei', size: 16, bold: true }
  detail.getRow(2).values = dataHeaders
  detail.getRow(2).font = {
    name: 'Microsoft YaHei',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  }
  detail.getRow(2).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF183B56' },
  }
  detail.getRow(2).height = 26
  detail.getCell('A3').value = '{{salesRows}}'
  return {
    filename: '销售汇总模板.xlsx',
    mediaType: XLSX_MEDIA_TYPE,
    content: Buffer.from(await workbook.xlsx.writeBuffer()),
  }
}

export async function generateSalesWorkbook(
  input: SalesReportInput,
): Promise<OfficeArtifact> {
  const rows = await parseSalesFile(input.data)
  const summary = summarizeSales(rows)
  const template = input.template ?? (await createSalesWorkbookTemplate())
  const { workbook, anchor } = await inspectWorkbookTemplate(template)
  const endRow = anchor.row + rows.length - 1
  const sheetRef = `'${anchor.sheet.name.replaceAll("'", "''")}'`
  const range = (column: string) =>
    `${sheetRef}!${column}${anchor.row}:${column}${endRow}`
  const values: Record<string, ExcelJS.CellValue> = {
    title: textValue(input.title ?? '销售经营汇总', '报告标题', 80),
    company: textValue(input.companyName ?? '公司', '公司名称', 80),
    period: `${summary.periodStart} 至 ${summary.periodEnd}`,
    source: input.data.filename,
    orderCount: {
      formula: `COUNTA(${range('A')})`,
      result: summary.orderCount,
    },
    units: { formula: `SUM(${range('E')})`, result: summary.units },
    revenue: {
      formula: `ROUND(SUM(${range('H')}),2)`,
      result: summary.revenue,
    },
    cost: { formula: `ROUND(SUM(${range('I')}),2)`, result: summary.cost },
    profit: { formula: `ROUND(SUM(${range('J')}),2)`, result: summary.profit },
    grossMargin: {
      formula: `IF(SUM(${range('H')})=0,"n.a.",SUM(${range('J')})/SUM(${range('H')}))`,
      result: summary.grossMargin ?? 'n.a.',
    },
  }
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value !== 'string' || cell.value === '{{salesRows}}')
          return
        const text = cell.value
        const full = /^\{\{(\w+)\}\}$/u.exec(text)
        if (full) {
          const key = full[1]!
          // ExcelJS shares imported style objects; a rate must not change money cells.
          cell.style = structuredClone(cell.style)
          cell.value = values[key] ?? ''
          if (key === 'grossMargin') cell.numFmt = '0.0%'
          else if (['revenue', 'cost', 'profit'].includes(key))
            cell.numFmt = '#,##0.00;[Red](#,##0.00)'
          else if (['orderCount', 'units'].includes(key)) cell.numFmt = '#,##0'
        } else
          cell.value = text.replace(/\{\{(\w+)\}\}/gu, (_, key: string) =>
            String(values[key]),
          )
      }),
    ),
  )
  anchor.sheet.getRow(anchor.row - 1).values = dataHeaders
  rows.forEach((data, index) => {
    const number = anchor.row + index
    const row = anchor.sheet.getRow(number)
    const revenue = (cents(data.unitPrice) * data.quantity) / 100
    const cost = (cents(data.unitCost) * data.quantity) / 100
    row.values = [
      data.orderId,
      new Date(`${data.date}T00:00:00Z`),
      data.region,
      data.product,
      data.quantity,
      data.unitPrice,
      data.unitCost,
      { formula: `ROUND(E${number}*F${number},2)`, result: revenue },
      { formula: `ROUND(E${number}*G${number},2)`, result: cost },
      {
        formula: `ROUND(H${number}-I${number},2)`,
        result: (cents(revenue) - cents(cost)) / 100,
      },
    ]
    row.height = 22
    row.font = { name: 'Microsoft YaHei', size: 11 }
    row.getCell(2).numFmt = 'yyyy-mm-dd'
    for (let column = 6; column <= 10; column++)
      row.getCell(column).numFmt = '#,##0.00;[Red](#,##0.00)'
  })
  anchor.sheet.autoFilter = {
    from: { row: anchor.row - 1, column: 1 },
    to: { row: endRow, column: 10 },
  }
  workbook.calcProperties.fullCalcOnLoad = true
  return {
    filename: '销售经营汇总.xlsx',
    mediaType: XLSX_MEDIA_TYPE,
    content: Buffer.from(await workbook.xlsx.writeBuffer()),
    summary,
  }
}
