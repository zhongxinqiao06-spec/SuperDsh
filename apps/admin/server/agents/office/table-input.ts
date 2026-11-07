import { createHash } from 'node:crypto'
import type ExcelJS from 'exceljs'
import { recalculateSupportedWorkbook } from './formula-import.ts'
import type {
  SpreadsheetSource,
  SpreadsheetTable,
  TableIssue,
  TableSelection,
  TableValue,
} from './generic-spreadsheet-types.ts'
import { parseCsv, readWorkbook } from './sales.ts'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import {
  OFFICE_LIMITS,
  readOfficeArchive,
  validateInput,
} from './validation.ts'

export interface SpreadsheetInspection {
  sources: SpreadsheetSource[]
  tables: SpreadsheetTable[]
  issues: TableIssue[]
}

function scalarCell(value: ExcelJS.CellValue): TableValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value !== 'object') return value
  if ('richText' in value)
    return value.richText.map((part) => part.text).join('')
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined)
      throw new OfficeInputError('公式缺少计算结果')
    return scalarCell(value.result)
  }
  throw new OfficeInputError('单元格包含不支持的错误值或外部链接')
}

export async function inspectSpreadsheetFeatures(file: OfficeInputFile) {
  if (validateInput(file, ['.csv', '.xlsx']) !== '.xlsx') return []
  const archive = readOfficeArchive(file)
  const features: string[] = []
  const names = Object.keys(archive.files)
  if (names.some((name) => /^xl\/(charts|drawings)\//u.test(name)))
    features.push('图表、图片或绘图对象')
  if (names.some((name) => /^xl\/(pivot|slicer|query|connections)/u.test(name)))
    features.push('数据透视表、切片器或数据连接')
  if (names.some((name) => /^xl\/tables\//u.test(name)))
    features.push('结构化表格对象')
  const worksheetXml = await Promise.all(
    archive
      .file(/^xl\/worksheets\/sheet\d+\.xml$/u)
      .map((sheet) => sheet.async('string')),
  )
  if (worksheetXml.some((xml) => /<conditionalFormatting\b/u.test(xml)))
    features.push('条件格式')
  return features
}

function selectHeader(rows: { values: TableValue[]; number: number }[]) {
  const candidates = rows.slice(0, 20).map((row) => {
    const filled = row.values.filter((value) => value !== null && value !== '')
    const strings = filled.filter((value) => typeof value === 'string')
    return {
      number: row.number,
      score:
        strings.length >= 2 && new Set(strings).size === strings.length
          ? filled.length
          : 0,
    }
  })
  const maximum = Math.max(0, ...candidates.map((row) => row.score))
  return (
    candidates.find((row) => row.score === maximum)?.number ??
    rows[0]?.number ??
    1
  )
}

function parseTable(
  fileIndex: number,
  file: OfficeInputFile,
  sheet: string,
  raw: { values: TableValue[]; number: number }[],
  selection: TableSelection | undefined,
  issues: TableIssue[],
): SpreadsheetTable {
  const id = `${fileIndex}:${sheet}`
  const headerRow = selection?.headerRow ?? selectHeader(raw)
  const header = raw.find((row) => row.number === headerRow)
  if (!header || !header.values.some((value) => value !== null && value !== ''))
    throw new OfficeInputError(
      `${file.filename} / ${sheet} 第 ${headerRow} 行不是有效表头`,
    )
  const width = Math.max(
    ...raw
      .filter((row) => row.number >= headerRow)
      .map((row) => row.values.length),
  )
  if (width > 64) throw new OfficeInputError('数据表最多支持 64 列')
  const columns = Array.from({ length: width }, (_, index) => {
    const original = String(header.values[index] ?? '').trim()
    if (!original)
      throw new OfficeInputError(
        `${file.filename} / ${sheet} 表头第 ${index + 1} 列为空，请指定正确表头行`,
      )
    return selection?.mapping?.[original] ?? original
  })
  if (
    columns.some((column) => !column.trim() || column.length > 100) ||
    new Set(columns).size !== columns.length
  )
    throw new OfficeInputError(
      `${file.filename} / ${sheet} 表头或映射后的字段为空、过长或重复`,
    )
  if (
    selection?.mapping &&
    Object.keys(selection.mapping).some(
      (key) =>
        !header.values.some((value) => String(value ?? '').trim() === key),
    )
  )
    throw new OfficeInputError(
      `${file.filename} / ${sheet} 字段映射引用了不存在的原始列`,
    )
  const records = raw.filter(
    (row) =>
      row.number > headerRow &&
      row.values.some((value) => value !== null && value !== ''),
  )
  if (records.length > OFFICE_LIMITS.rows)
    throw new OfficeInputError('数据不能超过 5000 行')
  if (headerRow > 1)
    issues.push({
      severity: 'warning',
      code: 'header-detected',
      tableId: id,
      row: headerRow,
      message: `已使用第 ${headerRow} 行作为表头，上方说明行保留在原始文件中`,
    })
  for (const row of records) {
    if (row.values.length !== width)
      issues.push({
        severity: 'warning',
        code: 'row-width',
        tableId: id,
        row: row.number,
        message: `第 ${row.number} 行缺少单元格，按空值处理`,
      })
  }
  return {
    id,
    fileIndex,
    filename: file.filename,
    sheet,
    headerRow,
    columns,
    rows: records.map((row) =>
      Array.from({ length: width }, (_, i) => row.values[i] ?? null),
    ),
    rowNumbers: records.map((row) => row.number),
  }
}

/** Inspect all sheets by default. Selection uses physical rows, never implicit demo data. */
export async function inspectSpreadsheetInputs(
  files: OfficeInputFile[],
  options: { selections?: TableSelection[]; signal?: AbortSignal } = {},
): Promise<SpreadsheetInspection> {
  if (!Array.isArray(files) || files.length > 10)
    throw new OfficeInputError('最多支持 10 份输入文件')
  const sources: SpreadsheetSource[] = [],
    tables: SpreadsheetTable[] = [],
    issues: TableIssue[] = []
  if (
    options.selections?.some(
      (selection) =>
        !Number.isInteger(selection.fileIndex) ||
        selection.fileIndex < 0 ||
        selection.fileIndex >= files.length ||
        (selection.headerRow !== undefined &&
          (!Number.isInteger(selection.headerRow) ||
            selection.headerRow < 1 ||
            selection.headerRow > 100)),
    )
  )
    throw new OfficeInputError('输入文件序号或表头行无效')
  for (const [fileIndex, file] of files.entries()) {
    options.signal?.throwIfAborted()
    const extension = validateInput(file, ['.csv', '.xlsx'])
    sources.push({
      fileIndex,
      filename: file.filename,
      sha256: createHash('sha256').update(file.content).digest('hex'),
    })
    const choices = options.selections?.filter(
      (selection) => selection.fileIndex === fileIndex,
    )
    if (options.selections?.length && !choices?.length) continue
    const features = await inspectSpreadsheetFeatures(file)
    if (features.length)
      issues.push({
        severity: 'warning',
        code: 'unsupported-visuals',
        tableId: `${fileIndex}:*`,
        message: `${file.filename} 包含${features.join('、')}。只有明确确认提取数据后才能处理；这些对象不能复制到新工作簿`,
      })
    if (extension === '.csv') {
      if (choices?.some((choice) => choice.sheet && choice.sheet !== 'CSV'))
        throw new OfficeInputError(`${file.filename} 只有 CSV 表`)
      const rows = parseCsv(file.content, { preserveEmptyRows: true }).map(
        (values, index) => ({ values, number: index + 1 }),
      )
      tables.push(
        parseTable(fileIndex, file, 'CSV', rows, choices?.[0], issues),
      )
    } else {
      const workbook = await readWorkbook(file)
      const calculated = recalculateSupportedWorkbook(workbook)
      if (
        choices?.some(
          (choice) => choice.sheet && !workbook.getWorksheet(choice.sheet),
        )
      )
        throw new OfficeInputError(`${file.filename} 指定工作表不存在`)
      for (const sheet of workbook.worksheets) {
        const selection = choices?.find(
          (choice) => !choice.sheet || choice.sheet === sheet.name,
        )
        if (choices?.length && !selection) continue
        if (!sheet.rowCount || !sheet.actualRowCount) {
          issues.push({
            severity: 'warning',
            code: 'empty-sheet',
            tableId: `${fileIndex}:${sheet.name}`,
            message: `${sheet.name} 是空表，已跳过`,
          })
          continue
        }
        const rows: { values: TableValue[]; number: number }[] = []
        sheet.eachRow((row, number) => {
          const values = Array.from({ length: row.cellCount }, (_, index) => {
            const cell = row.getCell(index + 1)
            // ExcelJS's value getter omits falsy formula caches (0, false, '').
            // Read our evaluated result rather than treating those as missing.
            return cell.formula
              ? (calculated.get(`${sheet.id}:${cell.address}`) ?? null)
              : scalarCell(cell.value)
          })
          while (values.at(-1) === null) values.pop()
          if (values.some((value) => value !== null && value !== ''))
            rows.push({ values, number })
        })
        tables.push(
          parseTable(fileIndex, file, sheet.name, rows, selection, issues),
        )
      }
    }
  }
  if (files.length && !tables.length)
    throw new OfficeInputError('没有可处理的数据表')
  const ids = new Set(tables.map((table) => table.id))
  if (ids.size !== tables.length)
    throw new OfficeInputError('同一个工作表只能选择一次')
  return { sources, tables, issues }
}
