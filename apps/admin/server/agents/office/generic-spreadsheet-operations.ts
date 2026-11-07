import {
  aggregateValues,
  columnIndex,
  compareValues,
  conditionMatches,
  evaluateFormula,
  ExactDecimal,
  validDate,
} from './formula.ts'
import type {
  FormulaExpression,
  SpreadsheetOperation,
  SpreadsheetTable,
  TableIssue,
  TableValue,
} from './generic-spreadsheet-types.ts'
import { OfficeInputError } from './types.ts'

export interface PreparedTable extends SpreadsheetTable {
  formulas: Record<
    string,
    { expression: FormulaExpression; numberFormat?: string }
  >
}

function assertColumns(columns: string[]) {
  if (
    !columns.length ||
    columns.length > 64 ||
    new Set(columns).size !== columns.length
  )
    throw new OfficeInputError('操作结果字段为空、超过 64 列或重名')
}
const rowKey = (row: TableValue[], indices: number[]) =>
  JSON.stringify(indices.map((index) => row[index] ?? null))
const plain = (table: SpreadsheetTable): SpreadsheetTable => ({
  ...table,
  columns: [...table.columns],
  rows: table.rows.map((row) => [...row]),
  rowNumbers: [...table.rowNumbers],
})

function assertCurrency(
  table: SpreadsheetTable,
  groups: string[],
  explicit?: string,
) {
  const currency =
    explicit ??
    table.columns.find((column) =>
      /^(currency|currencycode|币种|货币|货币代码)$/iu.test(column),
    )
  if (!currency || groups.includes(currency)) return
  const index = columnIndex(table, currency)
  const currencies = new Set(
    table.rows
      .map((row) => row[index])
      .filter((value) => value !== null && value !== ''),
  )
  if (currencies.size > 1)
    throw new OfficeInputError(
      `存在多个币种，请将“${currency}”加入分组，不能直接合计`,
    )
}

export function applySpreadsheetOperations(
  source: SpreadsheetTable,
  operations: SpreadsheetOperation[],
  available: Map<string, SpreadsheetTable>,
  issues: TableIssue[],
  signal?: AbortSignal,
): PreparedTable {
  let table: PreparedTable = { ...plain(source), formulas: {} }
  for (const [step, operation] of operations.entries()) {
    signal?.throwIfAborted()
    const indices = (columns: string[]) =>
      columns.map((column) => columnIndex(table, column))
    const existing = (id: string) => {
      const found = available.get(id)
      if (!found) throw new OfficeInputError(`引用表不存在或尚未生成：${id}`)
      return found
    }
    if (operation.type === 'select') {
      const selected = indices(operation.columns)
      table.rows = table.rows.map((row) =>
        selected.map((index) => row[index] ?? null),
      )
      table.columns = [...operation.columns]
      table.formulas = Object.fromEntries(
        Object.entries(table.formulas).filter(([column]) =>
          table.columns.includes(column),
        ),
      )
    } else if (operation.type === 'rename') {
      indices(Object.keys(operation.columns))
      if (Object.keys(table.formulas).length)
        throw new OfficeInputError('请在添加公式之前重命名字段')
      table.columns = table.columns.map(
        (column) => operation.columns[column] ?? column,
      )
    } else if (operation.type === 'trim') {
      const selected = indices(operation.columns)
      table.rows = table.rows.map((row) =>
        row.map((value, index) =>
          selected.includes(index) && typeof value === 'string'
            ? value.trim()
            : value,
        ),
      )
    } else if (operation.type === 'convert') {
      const index = columnIndex(table, operation.column)
      table.rows = table.rows.map((row, rowIndex) => {
        const next = [...row],
          value = row[index] ?? null
        if (value === null || value === '') return next
        try {
          if (operation.to === 'text') next[index] = String(value)
          else if (operation.to === 'number')
            next[index] = ExactDecimal.from(value).number()
          else if (operation.to === 'date')
            next[index] = validDate(value).toISOString().slice(0, 10)
          else if (typeof value === 'boolean') next[index] = value
          else if (/^(true|1|是)$/iu.test(String(value))) next[index] = true
          else if (/^(false|0|否)$/iu.test(String(value))) next[index] = false
          else throw new OfficeInputError('不能识别为布尔值')
        } catch (error) {
          const message = `${operation.column} 第 ${table.rowNumbers[rowIndex] ?? rowIndex + 2} 行：${error instanceof Error ? error.message : '类型转换失败'}`
          if (operation.onInvalid !== 'blank')
            throw new OfficeInputError(message)
          next[index] = null
          issues.push({
            tableId: table.id,
            severity: 'warning',
            code: 'conversion-blank',
            row: table.rowNumbers[rowIndex],
            column: operation.column,
            message,
          })
        }
        return next
      })
      delete table.formulas[operation.column]
    } else if (operation.type === 'filter') {
      operation.conditions.forEach((condition) =>
        columnIndex(table, condition.column),
      )
      const keep = table.rows
        .map((row, index) => ({ row, originalRow: table.rowNumbers[index]! }))
        .filter(({ row }) => {
          const matches = operation.conditions.map((condition) =>
            conditionMatches(condition, table, row),
          )
          return operation.match === 'any'
            ? matches.some(Boolean)
            : matches.every(Boolean)
        })
      table.rows = keep.map((item) => item.row)
      table.rowNumbers = keep.map((item) => item.originalRow)
    } else if (operation.type === 'sort') {
      const selected = operation.by.map((order) => ({
        index: columnIndex(table, order.column),
        direction: order.direction === 'desc' ? -1 : 1,
      }))
      const ordered = table.rows
        .map((row, index) => ({ row, originalRow: table.rowNumbers[index]! }))
        .sort((left, right) => {
          for (const order of selected) {
            const result = compareValues(
              left.row[order.index] ?? null,
              right.row[order.index] ?? null,
            )
            if (result) return result * order.direction
          }
          return 0
        })
      table.rows = ordered.map((item) => item.row)
      table.rowNumbers = ordered.map((item) => item.originalRow)
    } else if (operation.type === 'dedup') {
      if (!operation.columns.length)
        throw new OfficeInputError('去重必须明确指定判断字段')
      const selected = indices(operation.columns),
        seen = new Set<string>()
      const kept = table.rows
        .map((row, index) => ({ row, originalRow: table.rowNumbers[index]! }))
        .filter(({ row, originalRow }) => {
          const key = rowKey(row, selected)
          if (!seen.has(key)) {
            seen.add(key)
            return true
          }
          issues.push({
            tableId: table.id,
            severity: 'warning',
            code: 'duplicate-removed',
            row: originalRow,
            message: `第 ${originalRow} 行根据 ${operation.columns.join('、')} 判定重复，已保留首条记录`,
          })
          return false
        })
      table.rows = kept.map((item) => item.row)
      table.rowNumbers = kept.map((item) => item.originalRow)
    } else if (operation.type === 'concat') {
      for (const id of operation.tables) {
        const other = existing(id)
        if (
          other.columns.length !== table.columns.length ||
          other.columns.some((column) => !table.columns.includes(column))
        )
          throw new OfficeInputError(
            `合并表 ${id} 字段不一致，请先映射为相同字段`,
          )
        const order = table.columns.map((column) => columnIndex(other, column))
        table.rows.push(
          ...other.rows.map((row) => order.map((index) => row[index] ?? null)),
        )
        table.rowNumbers.push(...other.rowNumbers)
      }
    } else if (operation.type === 'join') {
      const other = existing(operation.table),
        leftKey = columnIndex(table, operation.leftKey),
        rightKey = columnIndex(other, operation.rightKey)
      const columns = Object.entries(operation.columns).map(
        ([name, alias]) => ({ index: columnIndex(other, name), alias }),
      )
      const lookup = new Map<string, TableValue[][]>()
      for (const row of other.rows) {
        if (row[rightKey] === null || row[rightKey] === '') continue
        const key = JSON.stringify(row[rightKey]),
          rows = lookup.get(key) ?? []
        rows.push(row)
        lookup.set(key, rows)
      }
      const next: TableValue[][] = [],
        rowNumbers: number[] = []
      for (const [index, row] of table.rows.entries()) {
        const matches = lookup.get(JSON.stringify(row[leftKey])) ?? []
        const joined = matches.length
          ? matches
          : operation.how === 'left'
            ? [null]
            : []
        for (const match of joined) {
          if (next.length >= 5000)
            throw new OfficeInputError('关联结果超过 5000 行，请检查重复关联键')
          next.push([
            ...row,
            ...columns.map((column) => match?.[column.index] ?? null),
          ])
          rowNumbers.push(table.rowNumbers[index]!)
        }
        if (!matches.length)
          issues.push({
            tableId: table.id,
            severity: 'warning',
            code: 'unmatched-join',
            row: table.rowNumbers[index],
            message: `第 ${table.rowNumbers[index]} 行未匹配到 ${operation.table}`,
          })
      }
      table.rows = next
      table.rowNumbers = rowNumbers
      table.columns.push(...columns.map((column) => column.alias))
    } else if (operation.type === 'group') {
      assertCurrency(table, operation.by, operation.currencyColumn)
      const groupIndices = indices(operation.by)
      const aggregateIndices = operation.aggregates.map((aggregate) =>
        columnIndex(table, aggregate.column),
      )
      const groups = new Map<string, TableValue[][]>()
      for (const row of table.rows) {
        const key = rowKey(row, groupIndices),
          rows = groups.get(key) ?? []
        rows.push(row)
        groups.set(key, rows)
      }
      if (!table.rows.length && !groupIndices.length) groups.set('[]', [])
      table = {
        ...table,
        columns: [
          ...operation.by,
          ...operation.aggregates.map((aggregate) => aggregate.as),
        ],
        rows: [...groups].map(([key, rows]) => [
          ...(JSON.parse(key) as TableValue[]),
          ...operation.aggregates.map((aggregate, index) =>
            aggregateValues(
              rows.map((row) => row[aggregateIndices[index]!] ?? null),
              aggregate.operation,
            ),
          ),
        ]),
        rowNumbers: Array.from(
          { length: groups.size },
          (_, index) => index + 2,
        ),
        formulas: {},
      }
    } else if (operation.type === 'pivot') {
      assertCurrency(
        table,
        [...operation.rows, operation.columns],
        operation.currencyColumn,
      )
      const groupIndices = indices(operation.rows),
        categoryIndex = columnIndex(table, operation.columns),
        valueIndex = columnIndex(table, operation.value)
      const categories = [
        ...new Set(
          table.rows.map((row) => String(row[categoryIndex] ?? '(空)')),
        ),
      ].sort()
      const groups = new Map<string, TableValue[][]>()
      for (const row of table.rows) {
        const key = rowKey(row, groupIndices),
          rows = groups.get(key) ?? []
        rows.push(row)
        groups.set(key, rows)
      }
      table = {
        ...table,
        columns: [...operation.rows, ...categories],
        rows: [...groups].map(([key, rows]) => [
          ...(JSON.parse(key) as TableValue[]),
          ...categories.map((category) =>
            aggregateValues(
              rows
                .filter(
                  (row) => String(row[categoryIndex] ?? '(空)') === category,
                )
                .map((row) => row[valueIndex] ?? null),
              operation.operation,
            ),
          ),
        ]),
        rowNumbers: Array.from(
          { length: groups.size },
          (_, index) => index + 2,
        ),
        formulas: {},
      }
    } else if (operation.type === 'formula') {
      if (table.columns.includes(operation.column))
        throw new OfficeInputError(
          `公式列 ${operation.column} 已存在，请使用新字段名`,
        )
      const values = table.rows.map((row) =>
        evaluateFormula(operation.expression, {
          table,
          row,
          tables: available,
        }),
      )
      table.columns.push(operation.column)
      table.rows = table.rows.map((row, index) => [...row, values[index]!])
      table.formulas[operation.column] = {
        expression: operation.expression,
        numberFormat: operation.numberFormat,
      }
    }
    assertColumns(table.columns)
    if (table.rows.length > 5000)
      throw new OfficeInputError(`第 ${step + 1} 步结果超过 5000 行`)
  }
  // Validate/recalculate emitted formulas in final row order, not their pre-sort coordinates.
  for (const [column, formula] of Object.entries(table.formulas)) {
    const index = columnIndex(table, column)
    for (const row of table.rows)
      row[index] = evaluateFormula(formula.expression, {
        table,
        row,
        tables: available,
      })
  }
  return table
}
