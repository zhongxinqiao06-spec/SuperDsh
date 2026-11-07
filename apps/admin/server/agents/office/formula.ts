import type {
  FormulaExpression,
  SpreadsheetTable,
  TableCondition,
  TableValue,
} from './generic-spreadsheet-types.ts'
import { OfficeInputError } from './types.ts'

/** Exact decimal/rational arithmetic until the final Excel numeric cell boundary. */
export class ExactDecimal {
  readonly numerator: bigint
  readonly denominator: bigint
  constructor(numerator: bigint, denominator = 1n) {
    this.numerator = numerator
    this.denominator = denominator
    if (!denominator) throw new OfficeInputError('计算出现除以零')
    if (
      numerator.toString().length > 100 ||
      denominator.toString().length > 100
    )
      throw new OfficeInputError('计算超出安全精度范围')
  }

  static from(value: TableValue): ExactDecimal {
    if (typeof value === 'boolean' || value === null || value === '')
      throw new OfficeInputError('计算需要数字，不能将空值或布尔值当作金额')
    const text = String(value).trim()
    const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(text)
    if (!match || text.length > 50)
      throw new OfficeInputError(`不是有效数字：${text.slice(0, 60)}`)
    const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0)
    if (Math.abs(scale) > 20)
      throw new OfficeInputError('数字小数位或指数超出支持范围')
    let numerator = BigInt(
      `${match[1] === '-' ? '-' : ''}${match[2]}${match[3] ?? ''}`,
    )
    if (scale < 0) numerator *= 10n ** BigInt(-scale)
    return new ExactDecimal(numerator, scale > 0 ? 10n ** BigInt(scale) : 1n)
  }

  private make(numerator: bigint, denominator: bigint) {
    if (denominator < 0n) {
      numerator = -numerator
      denominator = -denominator
    }
    let a = numerator < 0n ? -numerator : numerator
    let b = denominator
    while (b) {
      const next = a % b
      a = b
      b = next
    }
    return new ExactDecimal(numerator / (a || 1n), denominator / (a || 1n))
  }
  add(other: ExactDecimal) {
    return this.make(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    )
  }
  subtract(other: ExactDecimal) {
    return this.make(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    )
  }
  multiply(other: ExactDecimal) {
    return this.make(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    )
  }
  divide(other: ExactDecimal) {
    if (!other.numerator) throw new OfficeInputError('计算出现除以零')
    return this.make(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    )
  }
  round(digits = 12) {
    if (!Number.isInteger(digits) || digits < -12 || digits > 12)
      throw new OfficeInputError('ROUND 小数位必须在 -12 到 12 之间')
    const scale = 10n ** BigInt(Math.abs(digits))
    const numerator = digits >= 0 ? this.numerator * scale : this.numerator
    const denominator =
      digits >= 0 ? this.denominator : this.denominator * scale
    const sign = numerator < 0n ? -1n : 1n
    const absolute = numerator < 0n ? -numerator : numerator
    const rounded = sign * ((absolute * 2n + denominator) / (2n * denominator))
    return digits >= 0
      ? this.make(rounded, scale)
      : this.make(rounded * scale, 1n)
  }
  number() {
    const value = Number(this.numerator) / Number(this.denominator)
    if (!Number.isFinite(value) || Math.abs(value) > 999_999_999_999_999)
      throw new OfficeInputError('数值超出 Excel 的安全精度范围')
    return value
  }
}

export function columnIndex(
  table: Pick<SpreadsheetTable, 'columns'>,
  name: string,
) {
  const index = table.columns.indexOf(name)
  if (index < 0) throw new OfficeInputError(`缺少字段：${name}`)
  return index
}

export function conditionMatches(
  condition: TableCondition,
  table: Pick<SpreadsheetTable, 'columns'>,
  row: TableValue[],
) {
  const left = row[columnIndex(table, condition.column)] ?? null
  const right = condition.value ?? null
  const empty = left === null || left === ''
  switch (condition.operator) {
    case 'empty':
      return empty
    case 'notEmpty':
      return !empty
    case 'contains':
      return String(left ?? '')
        .toLocaleLowerCase('en-US')
        .includes(String(right ?? '').toLocaleLowerCase('en-US'))
    case 'eq':
      return (
        spreadsheetEqual(left, right) ||
        String(left ?? '').toLocaleLowerCase('en-US') ===
          String(right ?? '').toLocaleLowerCase('en-US')
      )
    case 'ne':
      return !(
        spreadsheetEqual(left, right) ||
        String(left ?? '').toLocaleLowerCase('en-US') ===
          String(right ?? '').toLocaleLowerCase('en-US')
      )
    default: {
      if (empty || right === null || right === '') return false
      const comparison = compareValues(left, right)
      if (condition.operator === 'gt') return comparison > 0
      if (condition.operator === 'gte') return comparison >= 0
      if (condition.operator === 'lt') return comparison < 0
      return comparison <= 0
    }
  }
}

export function compareValues(left: TableValue, right: TableValue) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', {
    numeric: true,
  })
}

export function spreadsheetEqual(left: TableValue, right: TableValue) {
  return typeof left === 'string' && typeof right === 'string'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

/** Excel COUNTIF/SUMIF criteria, including literal wildcard escaping. */
export function excelCriteriaMatches(value: TableValue, criterion: TableValue) {
  const text = String(criterion ?? '')
  const match = /^(<>|<=|>=|=|<|>)(.*)$/u.exec(text)
  const operator = match?.[1] ?? '='
  const expected = match?.[2] ?? text
  let equal: boolean
  if (expected === '') equal = value === null || value === ''
  else if (/^[+-]?\d+(?:\.\d+)?$/u.test(expected))
    equal = value !== null && value !== '' && Number(value) === Number(expected)
  else {
    let pattern = ''
    for (let index = 0; index < expected.length; index++) {
      const char = expected[index]!
      if (char === '~' && index + 1 < expected.length) {
        pattern += expected[++index]!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        continue
      }
      pattern +=
        char === '*'
          ? '.*'
          : char === '?'
            ? '.'
            : char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    }
    equal = new RegExp(`^${pattern}$`, 'iu').test(String(value ?? ''))
  }
  if (operator === '=') return equal
  if (operator === '<>') return !equal
  if (value === null || value === '') return false
  const comparison = /^[+-]?\d+(?:\.\d+)?$/u.test(expected)
    ? Number(value) - Number(expected)
    : String(value).localeCompare(expected, 'en', { sensitivity: 'accent' })
  return operator === '<'
    ? comparison < 0
    : operator === '<='
      ? comparison <= 0
      : operator === '>'
        ? comparison > 0
        : comparison >= 0
}

export function aggregateValues(
  values: TableValue[],
  operation: 'sum' | 'average' | 'min' | 'max' | 'count' | 'countDistinct',
): TableValue {
  const nonempty = values.filter((value) => value !== null && value !== '')
  if (operation === 'count') return nonempty.length
  if (operation === 'countDistinct')
    return new Set(
      nonempty.map((value) => String(value).toLocaleLowerCase('en-US')),
    ).size
  if (!nonempty.length) return operation === 'sum' ? 0 : null
  const numbers = nonempty.map((value) => ExactDecimal.from(value))
  if (operation === 'min' || operation === 'max')
    return numbers
      .reduce((best, value) =>
        (
          operation === 'min'
            ? value.number() < best.number()
            : value.number() > best.number()
        )
          ? value
          : best,
      )
      .number()
  const total = numbers.reduce(
    (sum, value) => sum.add(value),
    ExactDecimal.from(0),
  )
  return (
    operation === 'average'
      ? total.divide(ExactDecimal.from(numbers.length))
      : total
  )
    .round()
    .number()
}

export function validDate(value: TableValue) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new OfficeInputError('日期必须为有效的 YYYY-MM-DD')
  const date = new Date(`${value}T00:00:00Z`)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new OfficeInputError(`日期无效：${value}`)
  return date
}

export interface FormulaContext {
  table: SpreadsheetTable
  row: TableValue[]
  tables: ReadonlyMap<string, SpreadsheetTable>
}

function aggregateCriterion(condition: TableCondition) {
  if (condition.operator === 'empty') return '='
  if (condition.operator === 'notEmpty') return '<>'
  const escaped = String(condition.value ?? '').replace(
    /[~*?]/gu,
    (char) => `~${char}`,
  )
  if (condition.operator === 'contains') return `*${escaped}*`
  const operators = {
    eq: '=',
    ne: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }
  return `${operators[condition.operator]}${escaped}`
}

export function evaluateFormula(
  expression: FormulaExpression,
  context: FormulaContext,
): TableValue {
  const evaluate = (child: FormulaExpression) => evaluateFormula(child, context)
  if ('literal' in expression) return expression.literal
  if ('aggregate' in expression) {
    const rows = expression.where
      ? context.table.rows.filter((row) =>
          excelCriteriaMatches(
            row[columnIndex(context.table, expression.where!.column)] ?? null,
            aggregateCriterion(expression.where!),
          ),
        )
      : context.table.rows
    const index = columnIndex(context.table, expression.column)
    const currencyIndex = context.table.columns.findIndex((column) =>
      /^(currency|currencycode|币种|货币|货币代码)$/iu.test(column),
    )
    if (
      ['sum', 'average', 'min', 'max'].includes(expression.aggregate) &&
      currencyIndex >= 0 &&
      new Set(
        rows
          .map((row) => row[currencyIndex])
          .filter((value) => value !== null && value !== ''),
      ).size > 1
    )
      throw new OfficeInputError(
        '汇总公式包含多个币种，请先按币种筛选或分组，不能直接合计',
      )
    if (
      ['sum', 'average', 'min', 'max'].includes(expression.aggregate) &&
      rows.some(
        (row) =>
          row[index] !== null &&
          row[index] !== '' &&
          typeof row[index] !== 'number',
      )
    )
      throw new OfficeInputError(
        `汇总公式字段 ${expression.column} 必须先转换为数字，避免 Excel 将文本数字忽略`,
      )
    if (
      expression.aggregate === 'countDistinct' &&
      rows.some(
        (row) =>
          /[~*?]/u.test(String(row[index] ?? '')) ||
          (typeof row[index] === 'string' &&
            /^[+-]?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/iu.test(row[index].trim())),
      )
    )
      throw new OfficeInputError(
        '去重计数公式不支持通配符或数字文本编号，请使用分组的去重计数操作，以保留编号差异',
      )
    return aggregateValues(
      rows.map((row) => row[index] ?? null),
      expression.aggregate,
    )
  }
  if ('column' in expression)
    return context.row[columnIndex(context.table, expression.column)] ?? null
  if ('lookup' in expression) {
    const {
      table: id,
      keyColumn,
      value,
      returnColumn,
      missing = null,
    } = expression.lookup
    const table = context.tables.get(id)
    if (!table) throw new OfficeInputError(`关联表不存在：${id}`)
    const key = columnIndex(table, keyColumn)
    const result = columnIndex(table, returnColumn)
    const input = evaluate(value)
    const matches = table.rows.filter((row) =>
      spreadsheetEqual(row[key] ?? null, input),
    )
    if (matches.length > 1)
      throw new OfficeInputError(
        `查找字段 ${keyColumn} 不唯一，请先去重或改用关联操作`,
      )
    return matches[0]?.[result] ?? missing
  }
  if ('op' in expression) {
    const left = evaluate(expression.left),
      right = evaluate(expression.right)
    if (expression.op === '=') return spreadsheetEqual(left, right)
    if (expression.op === '<>') return !spreadsheetEqual(left, right)
    if (expression.op === '<') return compareValues(left, right) < 0
    if (expression.op === '<=') return compareValues(left, right) <= 0
    if (expression.op === '>') return compareValues(left, right) > 0
    if (expression.op === '>=') return compareValues(left, right) >= 0
    const a = ExactDecimal.from(left),
      b = ExactDecimal.from(right)
    if (expression.op === '+') return a.add(b).round().number()
    if (expression.op === '-') return a.subtract(b).round().number()
    if (expression.op === '*') return a.multiply(b).round().number()
    return a.divide(b).round().number()
  }
  if (expression.fn === 'IF') {
    const condition = evaluate(expression.args[0]!)
    if (typeof condition !== 'boolean' && typeof condition !== 'number')
      throw new OfficeInputError(
        'IF 条件必须为比较结果、布尔值或数字，请明确比较文本或空值',
      )
    return condition
      ? evaluate(expression.args[1]!)
      : evaluate(expression.args[2]!)
  }
  const args = expression.args.map(evaluate)
  if (expression.fn === 'ROUND')
    return ExactDecimal.from(args[0]!)
      .round(Number(args[1] ?? 0))
      .number()
  if (expression.fn === 'ABS')
    return Math.abs(ExactDecimal.from(args[0]!).number())
  if (expression.fn === 'CONCAT')
    return args.map((value) => value ?? '').join('')
  if (expression.fn === 'TRIM')
    return String(args[0] ?? '')
      .trim()
      .replace(/\s+/gu, ' ')
  if (expression.fn === 'UPPER') return String(args[0] ?? '').toUpperCase()
  if (expression.fn === 'LOWER') return String(args[0] ?? '').toLowerCase()
  if (expression.fn === 'DATE') {
    const values = args.map(Number)
    if (values.some((value) => !Number.isInteger(value)))
      throw new OfficeInputError('DATE 需要整数年月日')
    const text = `${String(values[0]).padStart(4, '0')}-${String(values[1]).padStart(2, '0')}-${String(values[2]).padStart(2, '0')}`
    return validDate(text).toISOString().slice(0, 10)
  }
  if (expression.fn === 'DAYS')
    return (
      (validDate(args[0]!).getTime() - validDate(args[1]!).getTime()) /
      86_400_000
    )
  const date = validDate(args[0]!)
  if (expression.fn === 'YEAR') return date.getUTCFullYear()
  if (expression.fn === 'MONTH') return date.getUTCMonth() + 1
  return date.getUTCDate()
}

export function excelColumn(index: number) {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  return result
}

export interface FormulaRenderContext {
  table: SpreadsheetTable
  rowNumber: number
  tables: ReadonlyMap<string, SpreadsheetTable>
  sheetNames: ReadonlyMap<string, string>
}

const excelLiteral = (value: TableValue): string =>
  typeof value === 'number'
    ? String(value)
    : typeof value === 'boolean'
      ? value
        ? 'TRUE'
        : 'FALSE'
      : `"${String(value ?? '').replaceAll('"', '""')}"`
const quotedSheet = (value: string) => `'${value.replaceAll("'", "''")}'`

export function renderFormula(
  expression: FormulaExpression,
  context: FormulaRenderContext,
): string {
  const render = (child: FormulaExpression) => renderFormula(child, context)
  const range = (table: SpreadsheetTable, column: string, sheetName?: string) =>
    `${sheetName ? `${quotedSheet(sheetName)}!` : ''}$${excelColumn(columnIndex(table, column))}$2:$${excelColumn(columnIndex(table, column))}$${Math.max(2, table.rows.length + 1)}`
  if ('literal' in expression) return excelLiteral(expression.literal)
  if ('aggregate' in expression) {
    const values = range(context.table, expression.column)
    if (expression.aggregate === 'countDistinct')
      return `SUMPRODUCT((${values}<>"")/COUNTIF(${values},${values}&""))`
    if (expression.where) {
      const condition = expression.where
      const criterion = aggregateCriterion(condition)
      const criteriaRange = range(context.table, condition.column)
      if (expression.aggregate === 'count')
        return `COUNTIFS(${criteriaRange},${excelLiteral(criterion)},${values},"<>")`
      if (['min', 'max'].includes(expression.aggregate))
        return `IF(COUNTIFS(${criteriaRange},${excelLiteral(criterion)},${values},"<>")=0,"",${expression.aggregate.toUpperCase()}IFS(${values},${criteriaRange},${excelLiteral(criterion)}))`
      const aggregation = `${expression.aggregate === 'average' ? 'AVERAGEIF' : 'SUMIF'}(${criteriaRange},${excelLiteral(criterion)},${values})`
      return expression.aggregate === 'average'
        ? `IF(COUNTIFS(${criteriaRange},${excelLiteral(criterion)},${values},"<>")=0,"",${aggregation})`
        : aggregation
    }
    if (expression.aggregate === 'count') return `COUNTIF(${values},"<>")`
    const fn = { sum: 'SUM', average: 'AVERAGE', min: 'MIN', max: 'MAX' }[
      expression.aggregate
    ]
    return expression.aggregate === 'sum'
      ? `${fn}(${values})`
      : `IF(COUNT(${values})=0,"",${fn}(${values}))`
  }
  if ('column' in expression)
    return `${excelColumn(columnIndex(context.table, expression.column))}${context.rowNumber}`
  if ('op' in expression)
    return `(${render(expression.left)}${expression.op}${render(expression.right)})`
  if ('lookup' in expression) {
    const table = context.tables.get(expression.lookup.table)
    const sheetName = context.sheetNames.get(expression.lookup.table)
    if (!table || !sheetName)
      throw new OfficeInputError(`查找表尚未输出：${expression.lookup.table}`)
    return `XLOOKUP(${render(expression.lookup.value)},${range(table, expression.lookup.keyColumn, sheetName)},${range(table, expression.lookup.returnColumn, sheetName)},${excelLiteral(expression.lookup.missing ?? null)},0)`
  }
  if (expression.fn === 'DATE')
    return `TEXT(DATE(${expression.args.map(render).join(',')}),"yyyy-mm-dd")`
  if (['YEAR', 'MONTH', 'DAY'].includes(expression.fn))
    return `${expression.fn}(DATEVALUE(${render(expression.args[0]!)}))`
  if (expression.fn === 'DAYS')
    return `(DATEVALUE(${render(expression.args[0]!)})-DATEVALUE(${render(expression.args[1]!)}))`
  return `${expression.fn}(${expression.args.map(render).join(',')})`
}
