import ExcelJS from 'exceljs'
import { recalculateSupportedWorkbook } from './formula-import.ts'
import { columnIndex, renderFormula } from './formula.ts'
import {
  addEditableWorkbookCharts,
  validateWorkbookChart,
  type WorkbookChart,
} from './generic-spreadsheet-charts.ts'
import {
  applySpreadsheetOperations,
  type PreparedTable,
} from './generic-spreadsheet-operations.ts'
import { validateOfficeSpreadsheetPlan } from './generic-spreadsheet-plan.ts'
import type {
  OfficeSpreadsheetInput,
  OfficeWorkbookArtifact,
  SpreadsheetTable,
  TableIssue,
} from './generic-spreadsheet-types.ts'
import { readWorkbook } from './sales.ts'
import { XLSX_MEDIA_TYPE } from './spreadsheet.ts'
import {
  inspectSpreadsheetFeatures,
  inspectSpreadsheetInputs,
} from './table-input.ts'
import { OfficeInputError } from './types.ts'

export { validateOfficeSpreadsheetPlan, inspectSpreadsheetInputs }
export type * from './generic-spreadsheet-types.ts'

/** Safe to send over worker IPC: plain data only; no Workbook/Map/Buffer in the result. */
export async function prepareOfficeSpreadsheet(input: OfficeSpreadsheetInput) {
  const plan = validateOfficeSpreadsheetPlan(input.plan)
  input.signal?.throwIfAborted()
  const inspection = await inspectSpreadsheetInputs(input.inputs, {
    selections: plan.sources,
    signal: input.signal,
  })
  if (
    inspection.issues.some((issue) => issue.code === 'unsupported-visuals') &&
    !plan.allowValueExtraction
  )
    throw new OfficeInputError(
      '输入包含暂不能保留的图表或绘图对象。请确认仅提取数据，或上传简化文件；原文件不会被修改',
    )
  const tables = new Map(inspection.tables.map((table) => [table.id, table]))
  const issues: TableIssue[] = [...inspection.issues]
  const prepared: PreparedTable[] = []
  for (const sheet of plan.sheets) {
    input.signal?.throwIfAborted()
    const source =
      typeof sheet.source === 'string'
        ? tables.get(sheet.source)
        : {
            id: `new:${sheet.name}`,
            fileIndex: -1,
            filename: '用户确认的新建数据',
            sheet: sheet.name,
            headerRow: 1,
            columns: sheet.source.columns,
            rows: sheet.source.rows,
            rowNumbers: sheet.source.rows.map((_, index) => index + 2),
          }
    if (!source)
      throw new OfficeInputError(
        `找不到输入表 ${String(sheet.source)}，请重新检查文件与工作表`,
      )
    const result = applySpreadsheetOperations(
      source,
      sheet.operations ?? [],
      tables,
      issues,
      input.signal,
    )
    result.id = `output:${sheet.name}`
    result.sheet = sheet.name
    for (const chart of sheet.charts ?? []) validateWorkbookChart(result, chart)
    // Validate formula dependencies before confirmation, including empty datasets.
    for (const formula of Object.values(result.formulas))
      renderFormula(formula.expression, {
        table: result,
        rowNumber: 2,
        tables,
        sheetNames: new Map(
          [...tables].map(([id, table]) => [id, table.sheet]),
        ),
      })
    prepared.push(result)
    tables.set(result.id, result)
  }
  if (input.template) {
    const features = await inspectSpreadsheetFeatures(input.template)
    if (features.length)
      throw new OfficeInputError(
        `模板包含${features.join('、')}，不能保证保留，请提供简化模板`,
      )
    const template = await readWorkbook(input.template)
    recalculateSupportedWorkbook(template)
    if (
      template.worksheets.some((sheet) =>
        plan.sheets.some(
          (output) => output.name.toLowerCase() === sheet.name.toLowerCase(),
        ),
      )
    )
      throw new OfficeInputError(
        '输出表名与模板已有表重名，请为输出选择新名称。现有模板表不会被覆盖',
      )
  }
  return {
    plan,
    sources: inspection.sources,
    inputs: inspection.tables,
    tables: prepared,
    issues,
    templateMode: input.template ? ('preserve-and-append' as const) : null,
  }
}

function uniqueName(requested: string, workbook: ExcelJS.Workbook) {
  const safe =
    requested.replace(/[\\/:?*[\]]/gu, '_').replace(/^'+|'+$/gu, '') || '数据'
  for (let suffix = 0; suffix < 1000; suffix++) {
    const end = suffix ? `_${suffix}` : ''
    const name = safe.slice(0, 31 - end.length) + end
    if (
      !workbook.worksheets.some(
        (sheet) => sheet.name.toLowerCase() === name.toLowerCase(),
      )
    )
      return name
  }
  throw new OfficeInputError('工作表名称过多')
}

function styleTable(sheet: ExcelJS.Worksheet, table: SpreadsheetTable) {
  sheet.columns = table.columns.map((column) => ({
    header: column,
    width: Math.min(36, Math.max(16, Array.from(column).length * 2 + 4)),
  }))
  for (const row of table.rows) sheet.addRow(row)
  sheet.getRow(1).height = 28
  sheet.getRow(1).font = {
    name: 'Microsoft YaHei',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  }
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF183B56' },
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.eachRow((row, index) => {
    if (index === 1) return
    row.height = 24
    row.font = { name: 'Microsoft YaHei', size: 11 }
    row.alignment = { vertical: 'middle', wrapText: true }
    if (index % 2 === 0)
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF3F6FA' },
      }
    row.eachCell((cell) => {
      if (typeof cell.value === 'number' && !Number.isInteger(cell.value))
        cell.numFmt = '#,##0.00##########'
    })
  })
  if (table.rows.length)
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: table.rows.length + 1, column: table.columns.length },
    }
  sheet.pageSetup = {
    paperSize: 9,
    orientation: table.columns.length > 6 ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  }
}

function copyRawSheet(
  source: ExcelJS.Worksheet,
  target: ExcelJS.Worksheet,
  names: Map<string, string>,
) {
  for (let index = 1; index <= source.columnCount; index++) {
    const from = source.getColumn(index),
      to = target.getColumn(index)
    to.width = from.width
    to.hidden = from.hidden
    to.style = structuredClone(from.style)
  }
  source.eachRow((row, index) => {
    const next = target.getRow(index)
    next.height = row.height
    next.hidden = row.hidden
    row.eachCell((cell, column) => {
      let value = structuredClone(cell.value)
      if (cell.formula) {
        const formula = cell.formula.replace(
          /('(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_ .]*)!/gu,
          (match, original: string) => {
            const name = original.replace(/^'|'$/gu, '').replaceAll("''", "'")
            const replacement = names.get(name)
            return replacement
              ? `'${replacement.replaceAll("'", "''")}'!`
              : match
          },
        )
        value = { formula, result: cell.result }
      }
      next.getCell(column).value = value
      next.getCell(column).style = structuredClone(cell.style)
      next.getCell(column).dataValidation = structuredClone(cell.dataValidation)
      if (cell.note) next.getCell(column).note = structuredClone(cell.note)
    })
  })
  for (const merge of source.model.merges ?? []) target.mergeCells(merge)
  target.views = structuredClone(source.views)
  target.pageSetup = structuredClone(source.pageSetup)
}

/** Generate only from an already-authorized input set. Caller owns confirmation and persistence. */
export async function generateOfficeWorkbook(
  input: OfficeSpreadsheetInput,
): Promise<OfficeWorkbookArtifact> {
  const prepared = await prepareOfficeSpreadsheet(input)
  const workbook = input.template
    ? await readWorkbook(input.template)
    : new ExcelJS.Workbook()
  if (input.template) recalculateSupportedWorkbook(workbook)
  workbook.creator = 'SuperDsh'
  workbook.title = prepared.plan.title
  const sheetNames = new Map<string, string>(),
    allTables = new Map<string, SpreadsheetTable>()
  const outputSheets = prepared.tables.map((table) => {
    const sheet = workbook.addWorksheet(table.sheet)
    sheetNames.set(table.id, sheet.name)
    allTables.set(table.id, table)
    styleTable(sheet, table)
    return sheet
  })
  // Normalized sources make lookups explicit and are not changed by later output operations.
  for (const table of prepared.inputs) {
    input.signal?.throwIfAborted()
    const sheet = workbook.addWorksheet(
      uniqueName(`数据${table.fileIndex + 1}_${table.sheet}`, workbook),
    )
    styleTable(sheet, table)
    sheetNames.set(table.id, sheet.name)
    allTables.set(table.id, table)
  }
  // Preserve supported original formulas/styles separately from normalized data and output.
  for (const [fileIndex, file] of input.inputs.entries()) {
    if (!prepared.inputs.some((table) => table.fileIndex === fileIndex))
      continue
    if (!file.filename.toLowerCase().endsWith('.xlsx')) continue
    input.signal?.throwIfAborted()
    const source = await readWorkbook(file)
    recalculateSupportedWorkbook(source)
    const names = new Map<string, string>()
    const targets = source.worksheets.map((sheet) => {
      const target = workbook.addWorksheet(
        uniqueName(`原始${fileIndex + 1}_${sheet.name}`, workbook),
      )
      names.set(sheet.name, target.name)
      return target
    })
    source.worksheets.forEach((sheet, index) =>
      copyRawSheet(sheet, targets[index]!, names),
    )
  }
  const charts: WorkbookChart[] = []
  for (const [index, table] of prepared.tables.entries()) {
    input.signal?.throwIfAborted()
    const sheet = outputSheets[index]!
    for (const [column, formula] of Object.entries(table.formulas)) {
      const columnNumber = columnIndex(table, column) + 1
      table.rows.forEach((row, rowIndex) => {
        const cell = sheet.getCell(rowIndex + 2, columnNumber)
        cell.value = {
          formula: renderFormula(formula.expression, {
            table,
            rowNumber: rowIndex + 2,
            tables: allTables,
            sheetNames,
          }),
          result: row[columnNumber - 1] ?? undefined,
        }
        if (formula.numberFormat) cell.numFmt = formula.numberFormat
      })
    }
    charts.push({
      sheetId: sheet.id,
      sheetName: sheet.name,
      table,
      charts: prepared.plan.sheets[index]?.charts ?? [],
    })
  }
  const notes = workbook.addWorksheet(uniqueName('来源与异常', workbook))
  notes.columns = [{ width: 20 }, { width: 38 }, { width: 90 }]
  notes.addRow(['类别', '位置', '说明'])
  notes.addRow(['方案', prepared.plan.title, JSON.stringify(prepared.plan)])
  notes.addRow([
    '计算口径',
    '数值',
    '采用十进制有理数计算；最终数值最多保留 12 位小数，金额小数位以确认方案 ROUND 为准。原始记录按行保留，订单数请明确使用 countDistinct。',
  ])
  for (const source of prepared.sources)
    notes.addRow(['输入来源', source.filename, `SHA-256 ${source.sha256}`])
  if (input.template)
    notes.addRow([
      '模板',
      input.template.filename,
      '已有工作表、支持的公式和样式保留，新增结果表，不覆盖原表',
    ])
  for (const issue of prepared.issues)
    notes.addRow([
      issue.code,
      `${issue.tableId}${issue.row ? ` / 第 ${issue.row} 行` : ''}`,
      issue.message,
    ])
  if (!prepared.issues.length)
    notes.addRow(['检查', '通过', '未发现需报告的数据异常'])
  notes.getRow(1).font = { bold: true, name: 'Microsoft YaHei' }
  notes.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: 'top' }
  })
  workbook.calcProperties.fullCalcOnLoad = true
  input.signal?.throwIfAborted()
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const content = await addEditableWorkbookCharts(bytes, charts)
  input.signal?.throwIfAborted()
  return {
    filename: prepared.plan.filename ?? '办公表格.xlsx',
    mediaType: XLSX_MEDIA_TYPE,
    content,
    provenance: prepared.sources,
    anomalies: prepared.issues,
    sheets: prepared.tables.map((table) => ({
      name: table.sheet,
      columns: table.columns,
      rowCount: table.rows.length,
    })),
  }
}
