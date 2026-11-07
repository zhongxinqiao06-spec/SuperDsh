import { text } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'

const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const names = (value: unknown) =>
  list(value)
    .map((value) => String(value))
    .join('、')
const aggregates: Record<string, string> = {
  sum: '合计',
  average: '平均',
  min: '最小值',
  max: '最大值',
  count: '计数',
  countDistinct: '去重计数',
}
const operators: Record<string, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '不小于',
  lt: '小于',
  lte: '不大于',
  contains: '包含',
  empty: '为空',
  notEmpty: '非空',
}
const condition = (value: unknown) => {
  const c = record(value)
  return `${text(c.column)}${operators[text(c.operator)] ?? text(c.operator)}${c.value === undefined ? '' : String(c.value)}`
}

export function formulaDescription(value: unknown): string {
  const e = record(value)
  if ('literal' in e) return JSON.stringify(e.literal)
  if ('op' in e)
    return `(${formulaDescription(e.left)} ${text(e.op)} ${formulaDescription(e.right)})`
  if ('fn' in e)
    return `${text(e.fn)}(${list(e.args).map(formulaDescription).join('，')})`
  if ('aggregate' in e)
    return `${aggregates[text(e.aggregate)] ?? text(e.aggregate)}［${text(e.column)}］${e.where ? `，条件：${condition(e.where)}` : ''}`
  if ('lookup' in e) {
    const l = record(e.lookup)
    return `查找 ${text(l.table)}：${text(l.keyColumn)} = ${formulaDescription(l.value)}，取 ${text(l.returnColumn)}，缺失时 ${JSON.stringify(l.missing ?? null)}`
  }
  return `［${text(e.column)}］`
}

export function operationDescription(op: Row): string {
  switch (op.type) {
    case 'select':
      return `保留字段：${names(op.columns)}`
    case 'rename':
      return `字段重命名：${Object.entries(record(op.columns))
        .map(([a, b]) => `${a} → ${String(b)}`)
        .join('；')}`
    case 'trim':
      return `清理首尾空白：${names(op.columns)}`
    case 'convert':
      return `${text(op.column)} 转为 ${text(op.to)}；异常值${op.onInvalid === 'blank' ? '置空并记录' : '停止并提示'}`
    case 'filter':
      return `筛选（${op.match === 'any' ? '满足任意条件' : '满足全部条件'}）：${list(op.conditions).map(condition).join('；')}`
    case 'sort':
      return `排序：${list(op.by)
        .map((item) => {
          const c = record(item)
          return `${text(c.column)} ${c.direction === 'desc' ? '降序' : '升序'}`
        })
        .join('；')}`
    case 'dedup':
      return `按 ${names(op.columns)} 去重`
    case 'concat':
      return `追加表格：${names(op.tables)}`
    case 'join':
      return `关联 ${text(op.table)}：${text(op.leftKey)} = ${text(op.rightKey)}（${op.how === 'inner' ? '仅保留匹配行' : '保留左表全部行'}）；取 ${Object.entries(
        record(op.columns),
      )
        .map(([a, b]) => `${a} → ${String(b)}`)
        .join('；')}`
    case 'group':
      return `按 ${names(op.by) || '全部数据'} 分组；${list(op.aggregates)
        .map((value) => {
          const a = record(value)
          return `${text(a.as)} = ${aggregates[text(a.operation)] ?? text(a.operation)}［${text(a.column)}］`
        })
        .join('；')}`
    case 'pivot':
      return `交叉统计：行 ${names(op.rows)}，列 ${text(op.columns)}，${aggregates[text(op.operation)] ?? text(op.operation)}［${text(op.value)}］`
    case 'formula':
      return `计算 ${text(op.column)} = ${formulaDescription(op.expression)}`
    default:
      return text(op.type)
  }
}
