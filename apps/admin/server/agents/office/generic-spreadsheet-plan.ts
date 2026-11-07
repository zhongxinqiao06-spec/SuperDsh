import type {
  FormulaExpression,
  OfficeSpreadsheetPlan,
  SpreadsheetOperation,
  TableAggregate,
  TableCondition,
  TableSelection,
  TableValue,
} from './generic-spreadsheet-types.ts'
import { OfficeInputError } from './types.ts'

type RecordValue = Record<string, unknown>
const fail = (label: string): never => {
  throw new OfficeInputError(`办公方案无效：${label}`)
}
function object(value: unknown, allowed: string[], label: string): RecordValue {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(`${label}包含未知字段或格式错误`)
  return value as RecordValue
}
const text = (value: unknown, label: string, maximum = 100): string =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= maximum &&
  !/[\x00-\x1f]/u.test(value)
    ? value.trim()
    : fail(`${label}不能为空或过长`)
const array = (value: unknown, label: string, maximum = 100): unknown[] =>
  Array.isArray(value) && value.length <= maximum
    ? value
    : fail(`${label}必须是列表且最多 ${maximum} 项`)
const strings = (value: unknown, label: string) =>
  array(value, label, 64).map((item) => text(item, label))
function choice<const T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  return typeof value === 'string' && choices.includes(value as T)
    ? (value as T)
    : fail(`${label}不支持`)
}
function value(input: unknown): TableValue {
  if (input === null || typeof input === 'boolean') return input
  if (typeof input === 'string' && input.length <= 4000) return input
  if (
    typeof input === 'number' &&
    Number.isFinite(input) &&
    Math.abs(input) <= 999_999_999_999_999
  )
    return input
  return fail('单元格只能是有限数字、文本、布尔值或空值')
}
function mapping(input: unknown) {
  const record = object(
    input,
    Object.keys(typeof input === 'object' && input ? input : {}),
    '字段映射',
  )
  if (Object.keys(record).length > 64) fail('映射字段过多')
  return Object.fromEntries(
    Object.entries(record).map(([key, val]) => [
      text(key, '映射字段'),
      text(val, '映射目标'),
    ]),
  )
}
function condition(input: unknown): TableCondition {
  const record = object(input, ['column', 'operator', 'value'], '筛选条件')
  return {
    column: text(record.column, '筛选字段'),
    operator: choice(
      record.operator,
      ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'notEmpty'],
      '筛选比较',
    ),
    ...(record.value !== undefined ? { value: value(record.value) } : {}),
  }
}
const aggregates = [
  'sum',
  'average',
  'min',
  'max',
  'count',
  'countDistinct',
] as const
function expression(input: unknown, depth = 0): FormulaExpression {
  if (depth > 16) fail('公式嵌套超过 16 层')
  const record = object(
    input,
    [
      'literal',
      'column',
      'op',
      'left',
      'right',
      'fn',
      'args',
      'aggregate',
      'where',
      'lookup',
    ],
    '公式',
  )
  const child = (item: unknown) => expression(item, depth + 1)
  if ('literal' in record && Object.keys(record).length === 1)
    return { literal: value(record.literal) }
  if ('aggregate' in record) {
    object(record, ['aggregate', 'column', 'where'], '汇总公式')
    const operation = choice(record.aggregate, aggregates, '汇总操作')
    if (operation === 'countDistinct' && record.where !== undefined)
      fail('条件去重计数请先筛选再分组')
    return {
      aggregate: operation,
      column: text(record.column, '汇总字段'),
      ...(record.where !== undefined ? { where: condition(record.where) } : {}),
    }
  }
  if ('column' in record && Object.keys(record).length === 1)
    return { column: text(record.column, '公式字段') }
  if ('op' in record) {
    object(record, ['op', 'left', 'right'], '算术公式')
    return {
      op: choice(
        record.op,
        ['+', '-', '*', '/', '=', '<>', '<', '<=', '>', '>='],
        '公式运算符',
      ),
      left: child(record.left),
      right: child(record.right),
    }
  }
  if ('fn' in record) {
    object(record, ['fn', 'args'], '函数')
    const fn = choice(
      record.fn,
      [
        'IF',
        'ROUND',
        'ABS',
        'YEAR',
        'MONTH',
        'DAY',
        'DATE',
        'DAYS',
        'CONCAT',
        'TRIM',
        'UPPER',
        'LOWER',
      ],
      '公式函数',
    )
    const args = array(record.args, '函数参数', 32).map(child)
    const expected =
      fn === 'IF' || fn === 'DATE'
        ? 3
        : fn === 'DAYS' || fn === 'ROUND'
          ? 2
          : fn === 'CONCAT'
            ? undefined
            : 1
    if (
      (expected !== undefined && args.length !== expected) ||
      args.length === 0
    )
      fail(`${fn} 参数数量不正确`)
    return { fn, args }
  }
  if ('lookup' in record && Object.keys(record).length === 1) {
    const lookup = object(
      record.lookup,
      ['table', 'keyColumn', 'value', 'returnColumn', 'missing'],
      '查找',
    )
    return {
      lookup: {
        table: text(lookup.table, '查找表', 240),
        keyColumn: text(lookup.keyColumn, '查找键'),
        value: child(lookup.value),
        returnColumn: text(lookup.returnColumn, '查找返回字段'),
        ...(lookup.missing !== undefined
          ? { missing: value(lookup.missing) }
          : {}),
      },
    }
  }
  return fail('公式结构不支持')
}
function operation(input: unknown): SpreadsheetOperation {
  if (!input || typeof input !== 'object' || !('type' in input))
    fail('操作缺少类型')
  const type = (input as RecordValue).type
  if (type === 'select' || type === 'trim' || type === 'dedup') {
    const record = object(input, ['type', 'columns'], '列操作')
    return { type, columns: strings(record.columns, '操作字段') }
  }
  if (type === 'rename') {
    const record = object(input, ['type', 'columns'], '重命名')
    return { type, columns: mapping(record.columns) }
  }
  if (type === 'convert') {
    const record = object(
      input,
      ['type', 'column', 'to', 'onInvalid'],
      '类型转换',
    )
    return {
      type,
      column: text(record.column, '转换字段'),
      to: choice(record.to, ['number', 'text', 'date', 'boolean'], '字段类型'),
      ...(record.onInvalid !== undefined
        ? {
            onInvalid: choice(
              record.onInvalid,
              ['error', 'blank'],
              '无效值处理',
            ),
          }
        : {}),
    }
  }
  if (type === 'filter') {
    const record = object(input, ['type', 'conditions', 'match'], '筛选')
    return {
      type,
      conditions: array(record.conditions, '筛选条件', 32).map(condition),
      ...(record.match !== undefined
        ? { match: choice(record.match, ['all', 'any'], '筛选匹配') }
        : {}),
    }
  }
  if (type === 'sort') {
    const record = object(input, ['type', 'by'], '排序')
    return {
      type,
      by: array(record.by, '排序字段', 64).map((item) => {
        const field = object(item, ['column', 'direction'], '排序字段')
        return {
          column: text(field.column, '排序字段'),
          ...(field.direction !== undefined
            ? {
                direction: choice(field.direction, ['asc', 'desc'], '排序方向'),
              }
            : {}),
        }
      }),
    }
  }
  if (type === 'concat') {
    const record = object(input, ['type', 'tables'], '合并')
    return {
      type,
      tables: array(record.tables, '合并表', 20).map((item) =>
        text(item, '表标识', 240),
      ),
    }
  }
  if (type === 'join') {
    const record = object(
      input,
      ['type', 'table', 'leftKey', 'rightKey', 'how', 'columns'],
      '关联',
    )
    return {
      type,
      table: text(record.table, '关联表', 240),
      leftKey: text(record.leftKey, '左键'),
      rightKey: text(record.rightKey, '右键'),
      how: choice(record.how, ['left', 'inner'], '关联方式'),
      columns: mapping(record.columns),
    }
  }
  if (type === 'group') {
    const record = object(
      input,
      ['type', 'by', 'aggregates', 'currencyColumn'],
      '分组',
    )
    const fields: TableAggregate[] = array(
      record.aggregates,
      '汇总字段',
      64,
    ).map((item) => {
      const field = object(item, ['column', 'as', 'operation'], '汇总字段')
      return {
        column: text(field.column, '汇总原字段'),
        as: text(field.as, '汇总名称'),
        operation: choice(field.operation, aggregates, '汇总操作'),
      }
    })
    if (!fields.length) fail('分组至少需要一个汇总字段')
    return {
      type,
      by: strings(record.by, '分组字段'),
      aggregates: fields,
      ...(record.currencyColumn !== undefined
        ? { currencyColumn: text(record.currencyColumn, '币种字段') }
        : {}),
    }
  }
  if (type === 'pivot') {
    const record = object(
      input,
      ['type', 'rows', 'columns', 'value', 'operation', 'currencyColumn'],
      '交叉统计',
    )
    return {
      type,
      rows: strings(record.rows, '行字段'),
      columns: text(record.columns, '列字段'),
      value: text(record.value, '数值字段'),
      operation: choice(record.operation, ['sum', 'count'], '交叉统计操作'),
      ...(record.currencyColumn !== undefined
        ? { currencyColumn: text(record.currencyColumn, '币种字段') }
        : {}),
    }
  }
  if (type === 'formula') {
    const record = object(
      input,
      ['type', 'column', 'expression', 'numberFormat'],
      '公式列',
    )
    return {
      type,
      column: text(record.column, '公式列名称'),
      expression: expression(record.expression),
      ...(record.numberFormat !== undefined
        ? {
            numberFormat: choice(
              record.numberFormat,
              [
                '0',
                '0.00',
                '#,##0',
                '#,##0.00',
                '0%',
                '0.0%',
                '0.00%',
                'yyyy-mm-dd',
              ],
              '数值格式',
            ),
          }
        : {}),
    }
  }
  return fail(`不支持操作 ${String(type)}`)
}

/** Runtime validation for untrusted model-produced JSON. No arbitrary script/formula text. */
export function validateOfficeSpreadsheetPlan(
  input: unknown,
): OfficeSpreadsheetPlan {
  if (JSON.stringify(input)?.length > 1_000_000) fail('方案过大')
  const plan = object(
    input,
    ['title', 'filename', 'sources', 'allowValueExtraction', 'sheets'],
    '方案',
  )
  let sources: TableSelection[] | undefined
  if (plan.sources !== undefined)
    sources = array(plan.sources, '输入选择', 100).map((item) => {
      const source = object(
        item,
        ['fileIndex', 'sheet', 'headerRow', 'mapping'],
        '输入选择',
      )
      if (
        !Number.isInteger(source.fileIndex) ||
        Number(source.fileIndex) < 0 ||
        Number(source.fileIndex) > 9
      )
        fail('文件序号必须为 0–9')
      if (
        source.headerRow !== undefined &&
        (!Number.isInteger(source.headerRow) ||
          Number(source.headerRow) < 1 ||
          Number(source.headerRow) > 100)
      )
        fail('表头行必须为 1–100')
      return {
        fileIndex: Number(source.fileIndex),
        ...(source.sheet !== undefined
          ? { sheet: text(source.sheet, '源工作表', 31) }
          : {}),
        ...(source.headerRow !== undefined
          ? { headerRow: Number(source.headerRow) }
          : {}),
        ...(source.mapping !== undefined
          ? { mapping: mapping(source.mapping) }
          : {}),
      }
    })
  if (
    plan.allowValueExtraction !== undefined &&
    typeof plan.allowValueExtraction !== 'boolean'
  )
    fail('提取数据确认必须为布尔值')
  const sheets = array(plan.sheets, '输出工作表', 10).map((item) => {
    const sheet = object(
      item,
      ['name', 'source', 'operations', 'charts'],
      '工作表',
    )
    const name = text(sheet.name, '工作表名', 31)
    if (
      /[\\/:?*[\]]/u.test(name) ||
      name.startsWith("'") ||
      name.endsWith("'") ||
      name === '来源与异常'
    )
      fail('工作表名包含无效字符或保留名称')
    let source: OfficeSpreadsheetPlan['sheets'][number]['source']
    if (typeof sheet.source === 'string')
      source = text(sheet.source, '源表标识', 240)
    else {
      const inline = object(sheet.source, ['columns', 'rows'], '新建表格')
      const columns = strings(inline.columns, '新建字段')
      if (!columns.length || new Set(columns).size !== columns.length)
        fail('新建字段为空或重复')
      const rows = array(inline.rows, '新建数据', 5000).map((row) =>
        array(row, '数据行', 64).map(value),
      )
      if (rows.some((row) => row.length !== columns.length))
        fail('新建数据行与字段数量不同')
      source = { columns, rows }
    }
    const charts =
      sheet.charts !== undefined
        ? array(sheet.charts, '图表', 5).map((item) => {
            const chart = object(
              item,
              ['type', 'title', 'category', 'values'],
              '图表',
            )
            return {
              type: choice(chart.type, ['column', 'line', 'pie'], '图表类型'),
              title: text(chart.title, '图表标题'),
              category: text(chart.category, '图表分类字段'),
              values: strings(chart.values, '图表数值字段'),
            }
          })
        : undefined
    return {
      name,
      source,
      ...(sheet.operations !== undefined
        ? { operations: array(sheet.operations, '操作步骤', 30).map(operation) }
        : {}),
      ...(charts ? { charts } : {}),
    }
  })
  if (
    !sheets.length ||
    new Set(sheets.map((sheet) => sheet.name.toLowerCase())).size !==
      sheets.length
  )
    fail('工作表为空或重名')
  const filename =
    plan.filename === undefined ? undefined : text(plan.filename, '文件名', 150)
  if (
    filename &&
    (!filename.toLowerCase().endsWith('.xlsx') ||
      /[\\/:*?"<>|]/u.test(filename))
  )
    fail('文件名必须是合法的 .xlsx 文件名')
  return {
    title: text(plan.title, '标题', 120),
    sheets,
    ...(filename ? { filename } : {}),
    ...(sources ? { sources } : {}),
    ...(plan.allowValueExtraction !== undefined
      ? { allowValueExtraction: plan.allowValueExtraction as boolean }
      : {}),
  }
}
