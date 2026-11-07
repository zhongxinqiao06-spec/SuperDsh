import type ExcelJS from 'exceljs'
import {
  ExactDecimal,
  excelCriteriaMatches,
  spreadsheetEqual,
  validDate,
} from './formula.ts'
import type { TableValue } from './generic-spreadsheet-types.ts'
import { OfficeInputError } from './types.ts'

type Node =
  | { kind: 'literal'; value: TableValue }
  | { kind: 'ref'; value: string }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }
type Value = TableValue | TableValue[]
const functions = new Set([
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'IF',
  'ROUND',
  'ABS',
  'AND',
  'OR',
  'NOT',
  'CONCAT',
  'CONCATENATE',
  'SUMIF',
  'SUMIFS',
  'AVERAGEIF',
  'COUNTIF',
  'COUNTIFS',
  'MINIFS',
  'MAXIFS',
  'SUMPRODUCT',
  'DATE',
  'DATEVALUE',
  'YEAR',
  'MONTH',
  'DAY',
  'TEXT',
  'TRIM',
  'UPPER',
  'LOWER',
  'XLOOKUP',
])

function parseFormula(input: string): Node {
  if (input.length > 2000) throw new OfficeInputError('原始公式过长')
  const tokens: string[] = []
  const pattern =
    /\s*("(?:[^"]|"")*"|(?:(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_ .]*)!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d*)?(?:E[+-]?\d+)?|[A-Z_][A-Z_0-9.]*|<>|<=|>=|[+\-*/&=<>(),])/giuy
  let offset = 0
  while (offset < input.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(input)
    if (!match)
      throw new OfficeInputError(
        `不支持原始公式语法：${input.slice(offset, offset + 30)}`,
      )
    tokens.push(match[1]!)
    offset = pattern.lastIndex
  }
  let position = 0
  const precedence: Record<string, number> = {
    '=': 1,
    '<>': 1,
    '<': 1,
    '<=': 1,
    '>': 1,
    '>=': 1,
    '+': 2,
    '-': 2,
    '*': 3,
    '/': 3,
    '&': 1.5,
  }
  const parse = (minimum = 0, depth = 0): Node => {
    if (depth > 32) throw new OfficeInputError('原始公式嵌套过深')
    const token = tokens[position++]
    if (!token) throw new OfficeInputError('原始公式不完整')
    let left: Node
    if (token === '(') {
      left = parse(0, depth + 1)
      if (tokens[position++] !== ')')
        throw new OfficeInputError('原始公式括号不匹配')
    } else if (token === '+' || token === '-') {
      left = {
        kind: 'binary',
        op: token,
        left: { kind: 'literal', value: 0 },
        right: parse(4, depth + 1),
      }
    } else if (token.startsWith('"'))
      left = {
        kind: 'literal',
        value: token.slice(1, -1).replaceAll('""', '"'),
      }
    else if (/^\d/u.test(token))
      left = { kind: 'literal', value: ExactDecimal.from(token).number() }
    else if (/^(TRUE|FALSE)$/iu.test(token))
      left = { kind: 'literal', value: token.toUpperCase() === 'TRUE' }
    else if (tokens[position] === '(') {
      const name = token.toUpperCase()
      if (!functions.has(name))
        throw new OfficeInputError(
          `不支持原始公式函数 ${name}，请转换为值或使用受控公式重建`,
        )
      position++
      const args: Node[] = []
      if (tokens[position] !== ')') {
        do {
          args.push(parse(0, depth + 1))
        } while (tokens[position] === ',' && position++)
      }
      if (tokens[position++] !== ')')
        throw new OfficeInputError('原始公式参数未闭合')
      left = { kind: 'call', name, args }
    } else if (/\d$/u.test(token)) left = { kind: 'ref', value: token }
    else throw new OfficeInputError(`不支持公式名称：${token}`)
    while ((precedence[tokens[position] ?? ''] ?? -1) >= minimum) {
      const op = tokens[position++]!
      left = {
        kind: 'binary',
        op,
        left,
        right: parse(precedence[op]! + 1, depth + 1),
      }
    }
    return left
  }
  const result = parse()
  if (position !== tokens.length)
    throw new OfficeInputError('原始公式存在不支持的尾部内容')
  return result
}

export function recalculateSupportedWorkbook(workbook: ExcelJS.Workbook) {
  const cache = new Map<string, TableValue>()
  const visiting = new Set<string>()
  let visitedReferences = 0
  const scalar = (value: Value): TableValue => {
    if (Array.isArray(value)) throw new OfficeInputError('此处不支持公式范围')
    return value
  }
  const number = (value: Value) => {
    const item = scalar(value)
    return ExactDecimal.from(
      typeof item === 'boolean' ? Number(item) : item === '' ? 0 : (item ?? 0),
    )
  }
  const cellValue = (sheet: ExcelJS.Worksheet, address: string): TableValue => {
    if (++visitedReferences > 2_000_000)
      throw new OfficeInputError('公式引用次数过多，请拆分工作簿')
    const key = `${sheet.id}:${address}`
    if (cache.has(key)) return cache.get(key)!
    if (visiting.has(key))
      throw new OfficeInputError(`公式循环引用：${sheet.name}!${address}`)
    visiting.add(key)
    const cell = sheet.getCell(address)
    const value = cell.value
    let result: TableValue
    if (cell.formula) {
      try {
        result = scalar(evaluate(parseFormula(cell.formula), sheet))
      } catch (error) {
        throw new OfficeInputError(
          `${sheet.name}!${address}：${error instanceof Error ? error.message : '公式计算失败'}`,
        )
      }
      cell.value = { formula: cell.formula, result: result ?? undefined }
    } else if (value === null || value === undefined) result = null
    else if (value instanceof Date) result = value.toISOString().slice(0, 10)
    else if (typeof value === 'object' && 'richText' in value)
      result = value.richText.map((part) => part.text).join('')
    else if (typeof value === 'object')
      throw new OfficeInputError(
        `${sheet.name}!${address} 含错误值或不支持的链接`,
      )
    else result = value
    visiting.delete(key)
    cache.set(key, result)
    return result
  }
  const evaluate = (node: Node, sheet: ExcelJS.Worksheet): Value => {
    if (node.kind === 'literal') return node.value
    if (node.kind === 'ref') {
      const parts = node.value.split('!')
      const target =
        parts.length === 2
          ? workbook.getWorksheet(
              parts[0]!.replace(/^'|'$/gu, '').replaceAll("''", "'"),
            )
          : sheet
      if (!target) throw new OfficeInputError(`公式工作表不存在：${parts[0]}`)
      const [start, end] = parts.at(-1)!.replaceAll('$', '').split(':')
      for (const address of [start, end].filter((value): value is string =>
        Boolean(value),
      )) {
        const match = /^([A-Z]+)(\d+)$/iu.exec(address)
        const col =
          match?.[1]
            ?.toUpperCase()
            .split('')
            .reduce(
              (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
              0,
            ) ?? 0
        if (
          !match ||
          Number(match[2]) < 1 ||
          Number(match[2]) > 5020 ||
          col > 64
        )
          throw new OfficeInputError('公式引用超出支持范围：5020 行、64 列')
      }
      if (!end) return cellValue(target, start!)
      const from = target.getCell(start!),
        to = target.getCell(end)
      if (
        Number(to.row) < Number(from.row) ||
        Number(to.col) < Number(from.col)
      )
        throw new OfficeInputError('公式范围必须从左上至右下')
      if (
        (Number(to.row) - Number(from.row) + 1) *
          (Number(to.col) - Number(from.col) + 1) >
        320_000
      )
        throw new OfficeInputError('公式范围过大')
      const values: TableValue[] = []
      for (let row = Number(from.row); row <= Number(to.row); row++)
        for (let col = Number(from.col); col <= Number(to.col); col++)
          values.push(cellValue(target, target.getCell(row, col).address))
      return values
    }
    if (node.kind === 'binary') {
      const left = evaluate(node.left, sheet),
        right = evaluate(node.right, sheet)
      const calculate = (left: TableValue, right: TableValue): TableValue => {
        if (node.op === '&') return `${left ?? ''}${right ?? ''}`
        if (node.op === '=') return spreadsheetEqual(left ?? '', right ?? '')
        if (node.op === '<>') return !spreadsheetEqual(left ?? '', right ?? '')
        if (['<', '<=', '>', '>='].includes(node.op)) {
          const a = scalar(left) ?? '',
            b = scalar(right) ?? ''
          if (typeof a !== typeof b)
            throw new OfficeInputError('公式比较项类型不一致')
          const difference =
            typeof a === 'number' && typeof b === 'number'
              ? a - b
              : String(a).localeCompare(String(b))
          return node.op === '<'
            ? difference < 0
            : node.op === '<='
              ? difference <= 0
              : node.op === '>'
                ? difference > 0
                : difference >= 0
        }
        const a = number(left),
          b = number(right)
        return (
          node.op === '+'
            ? a.add(b)
            : node.op === '-'
              ? a.subtract(b)
              : node.op === '*'
                ? a.multiply(b)
                : a.divide(b)
        )
          .round()
          .number()
      }
      if (Array.isArray(left) || Array.isArray(right)) {
        const a = Array.isArray(left)
          ? left
          : Array.from({ length: (right as TableValue[]).length }, () => left)
        const b = Array.isArray(right)
          ? right
          : Array.from({ length: a.length }, () => right)
        if (a.length !== b.length)
          throw new OfficeInputError('公式范围大小不一致')
        return a.map((value, index) => calculate(value, b[index]!))
      }
      return calculate(left, right)
    }
    if (node.name === 'IF') {
      if (node.args.length !== 3) throw new OfficeInputError('IF 需要三个参数')
      const condition = scalar(evaluate(node.args[0]!, sheet))
      if (
        condition !== null &&
        typeof condition !== 'boolean' &&
        typeof condition !== 'number'
      )
        throw new OfficeInputError('IF 文本条件不受支持，请先明确比较')
      return evaluate(node.args[condition ? 1 : 2]!, sheet)
    }
    const args = node.args.map((arg) => evaluate(arg, sheet))
    const range = (index: number): TableValue[] =>
      Array.isArray(args[index])
        ? (args[index] as TableValue[])
        : [scalar(args[index] ?? null)]
    if (node.name === 'XLOOKUP') {
      if (args.length < 3 || (args[4] !== undefined && args[4] !== 0))
        throw new OfficeInputError('XLOOKUP 只支持精确查找')
      const keys = range(1),
        results = range(2),
        key = scalar(args[0]!)
      if (keys.length !== results.length)
        throw new OfficeInputError('查找范围大小不一致')
      const index = keys.findIndex((value) => spreadsheetEqual(value, key))
      return index < 0 ? scalar(args[3] ?? '') : results[index]!
    }
    if (
      [
        'COUNTIF',
        'COUNTIFS',
        'SUMIF',
        'SUMIFS',
        'AVERAGEIF',
        'MINIFS',
        'MAXIFS',
      ].includes(node.name)
    ) {
      const single = ['COUNTIF', 'SUMIF', 'AVERAGEIF'].includes(node.name)
      const counting = node.name.startsWith('COUNT')
      const data = counting
        ? range(0)
        : single
          ? range(args.length > 2 ? 2 : 0)
          : range(0)
      const criteriaIndices = single
        ? [0]
        : Array.from(
            { length: Math.floor((args.length - (counting ? 0 : 1)) / 2) },
            (_, index) => index * 2 + (counting ? 0 : 1),
          )
      const calculate = (firstCriterion?: TableValue) => {
        const keep = data.filter((_value, index) =>
          criteriaIndices.every((rangeIndex, pair) => {
            const values = range(rangeIndex)
            if (values.length !== data.length)
              throw new OfficeInputError('条件汇总范围大小不一致')
            const criterion =
              pair === 0 && firstCriterion !== undefined
                ? firstCriterion
                : scalar(args[rangeIndex + 1] ?? null)
            return excelCriteriaMatches(values[index] ?? null, criterion)
          }),
        )
        if (counting) return keep.length
        const numbers = keep.filter(
          (value): value is number => typeof value === 'number',
        )
        if (node.name === 'MINIFS')
          return numbers.length ? Math.min(...numbers) : 0
        if (node.name === 'MAXIFS')
          return numbers.length ? Math.max(...numbers) : 0
        const sum = numbers.reduce(
          (total, value) => total.add(ExactDecimal.from(value)),
          ExactDecimal.from(0),
        )
        return (
          node.name === 'AVERAGEIF'
            ? sum.divide(ExactDecimal.from(numbers.length))
            : sum
        )
          .round()
          .number()
      }
      if (node.name === 'COUNTIF' && Array.isArray(args[1]))
        return args[1].map((item) => calculate(item))
      return calculate()
    }
    if (node.name === 'DATEVALUE')
      return Math.round(
        (validDate(scalar(args[0]!)).getTime() - Date.UTC(1899, 11, 30)) /
          86_400_000,
      )
    if (node.name === 'DATE') {
      const text = `${String(scalar(args[0]!)).padStart(4, '0')}-${String(scalar(args[1]!)).padStart(2, '0')}-${String(scalar(args[2]!)).padStart(2, '0')}`
      return Math.round(
        (validDate(text).getTime() - Date.UTC(1899, 11, 30)) / 86_400_000,
      )
    }
    if (['YEAR', 'MONTH', 'DAY', 'TEXT'].includes(node.name)) {
      const date = new Date(
        Date.UTC(1899, 11, 30) + Number(scalar(args[0]!)) * 86_400_000,
      )
      if (!Number.isFinite(date.getTime()))
        throw new OfficeInputError('日期公式无效')
      if (node.name === 'YEAR') return date.getUTCFullYear()
      if (node.name === 'MONTH') return date.getUTCMonth() + 1
      if (node.name === 'DAY') return date.getUTCDate()
      if (scalar(args[1]!) !== 'yyyy-mm-dd')
        throw new OfficeInputError('TEXT 目前只支持 yyyy-mm-dd 日期格式')
      return date.toISOString().slice(0, 10)
    }
    if (node.name === 'TRIM')
      return String(scalar(args[0]!) ?? '')
        .trim()
        .replace(/\s+/gu, ' ')
    if (node.name === 'UPPER')
      return String(scalar(args[0]!) ?? '').toUpperCase()
    if (node.name === 'LOWER')
      return String(scalar(args[0]!) ?? '').toLowerCase()
    if (node.name === 'SUMPRODUCT' && args.length > 1) {
      const ranges = args.map((_, index) => range(index))
      if (ranges.some((values) => values.length !== ranges[0]!.length))
        throw new OfficeInputError('SUMPRODUCT 范围大小不一致')
      return ranges[0]!
        .reduce<ExactDecimal>(
          (total, _value, index) =>
            total.add(
              ranges.reduce(
                (product, values) =>
                  product.multiply(number(values[index] ?? 0)),
                ExactDecimal.from(1),
              ),
            ),
          ExactDecimal.from(0),
        )
        .round()
        .number()
    }
    const values = args.flatMap((arg) => arg)
    if (
      ['AND', 'OR', 'NOT'].includes(node.name) &&
      values.some(
        (value) => typeof value !== 'boolean' && typeof value !== 'number',
      )
    )
      throw new OfficeInputError('逻辑公式只支持明确的比较结果、布尔值或数字')
    if (node.name === 'AND') return values.every(Boolean)
    if (node.name === 'OR') return values.some(Boolean)
    if (node.name === 'NOT') return !values[0]
    if (node.name === 'CONCAT' || node.name === 'CONCATENATE')
      return values.map((value) => value ?? '').join('')
    if (node.name === 'ROUND')
      return ExactDecimal.from(values[0] ?? 0)
        .round(Number(values[1] ?? 0))
        .number()
    if (node.name === 'ABS')
      return Math.abs(ExactDecimal.from(values[0] ?? 0).number())
    if (node.name === 'COUNTA')
      return values.filter((value) => value !== null).length
    const numericArguments = args.flatMap((arg, index) => {
      if (
        node.name === 'SUMPRODUCT' ||
        node.args[index]?.kind !== 'literal' ||
        typeof arg === 'number' ||
        Array.isArray(arg)
      )
        return arg
      if (typeof arg === 'boolean') return Number(arg)
      try {
        return ExactDecimal.from(arg).number()
      } catch (error) {
        if (node.name === 'COUNT') return null
        throw error
      }
    })
    const numbers = numericArguments.filter(
      (value): value is number => typeof value === 'number',
    )
    if (node.name === 'COUNT') return numbers.length
    if (node.name === 'MIN') return numbers.length ? Math.min(...numbers) : 0
    if (node.name === 'MAX') return numbers.length ? Math.max(...numbers) : 0
    const total = numbers.reduce(
      (sum, value) => sum.add(ExactDecimal.from(value)),
      ExactDecimal.from(0),
    )
    return (
      node.name === 'AVERAGE'
        ? total.divide(ExactDecimal.from(numbers.length))
        : total
    )
      .round()
      .number()
  }
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        cellValue(sheet, cell.address)
      }),
    ),
  )
  return cache
}
