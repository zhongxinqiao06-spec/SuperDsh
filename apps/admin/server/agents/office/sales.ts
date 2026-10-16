import ExcelJS from 'exceljs'
import {
  OfficeInputError,
  type OfficeInputFile,
  type SalesGroup,
  type SalesRow,
  type SalesSummary,
} from './types.ts'
import {
  OFFICE_LIMITS,
  parseXml,
  readOfficeArchive,
  textValue,
  validateInput,
} from './validation.ts'

const columns = [
  'orderId',
  'date',
  'region',
  'product',
  'quantity',
  'unitPrice',
  'unitCost',
] as const
const aliases: Record<string, string> = {
  订单编号: 'orderId',
  日期: 'date',
  区域: 'region',
  产品: 'product',
  数量: 'quantity',
  单价: 'unitPrice',
  单位成本: 'unitCost',
}

export function parseCsv(content: Buffer) {
  let input: string
  try {
    input = new TextDecoder('utf-8', { fatal: true })
      .decode(content)
      .replace(/^\uFEFF/u, '')
  } catch {
    throw new OfficeInputError('CSV 必须使用 UTF-8 编码')
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  const finishField = () => {
    if (row.length >= 64) throw new OfficeInputError('表格最多支持 64 列')
    row.push(field)
    field = ''
    closed = false
  }
  const finishRow = () => {
    finishField()
    if (row.some((cell) => cell.trim())) rows.push(row)
    if (rows.length > OFFICE_LIMITS.rows + 1)
      throw new OfficeInputError('数据不能超过 5000 行')
    row = []
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
        closed = true
      } else field += char
    } else if (char === '"' && !field && !closed) quoted = true
    else if (char === ',') finishField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      finishRow()
    } else if (closed || char === '"')
      throw new OfficeInputError('CSV 引号格式不正确')
    else field += char
    if (field.length > 4000)
      throw new OfficeInputError('单个单元格不能超过 4000 个字符')
  }
  if (quoted) throw new OfficeInputError('CSV 引号未闭合')
  if (field || row.length || closed) finishRow()
  return rows
}

export async function readWorkbook(file: OfficeInputFile) {
  const archive = readOfficeArchive(file)
  if (!archive.file('xl/workbook.xml'))
    throw new OfficeInputError('文件不是 XLSX 工作簿')
  const sheets = archive.file(/^xl\/worksheets\/sheet\d+\.xml$/u)
  if (sheets.length > 10)
    throw new OfficeInputError('工作簿不能超过 10 个工作表')
  for (const sheet of sheets) {
    const doc = parseXml(await sheet.async('string'))
    for (const cell of Array.from(doc.getElementsByTagName('c'))) {
      const address = cell.getAttribute('r') ?? ''
      const match = /^([A-Z]+)(\d+)$/u.exec(address)
      const column =
        match?.[1]
          ?.split('')
          .reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) ?? 0
      if (!match || Number(match[2]) > OFFICE_LIMITS.rows + 20 || column > 64) {
        throw new OfficeInputError('工作表超出支持范围：最多 5020 行、64 列')
      }
    }
  }
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Uint8Array.from(file.content).buffer)
  } catch {
    throw new OfficeInputError('无法读取 XLSX 文件，请确认文件未损坏')
  }
  return workbook
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('richText' in value)
      return value.richText.map((part) => part.text).join('')
    throw new OfficeInputError(
      '输入销售数据不能含公式、错误值或链接，请粘贴为值后上传',
    )
  }
  return String(value)
}

export async function readTable(file: OfficeInputFile) {
  const extension = validateInput(file, ['.csv', '.xlsx'])
  if (extension === '.csv') return parseCsv(file.content)
  const workbook = await readWorkbook(file)
  const sheet =
    workbook.getWorksheet('销售数据') ??
    (workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined)
  if (!sheet)
    throw new OfficeInputError('多个工作表时请将输入数据表命名为“销售数据”')
  const rows: string[][] = []
  sheet.eachRow((row) => {
    const values: string[] = []
    for (let col = 1; col <= sheet.columnCount; col++)
      values.push(cellText(row.getCell(col).value))
    if (values.some((value) => value.trim())) rows.push(values)
  })
  if (rows.length > OFFICE_LIMITS.rows + 1)
    throw new OfficeInputError('数据不能超过 5000 行')
  return rows
}

function numeric(value: string, label: string, integer = false) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value.trim())) {
    throw new OfficeInputError(`${label}必须为非负数字，金额最多两位小数`)
  }
  const number = Number(value)
  if (
    number > 1_000_000 ||
    (integer && (!Number.isInteger(number) || number < 1))
  ) {
    throw new OfficeInputError(
      `${label}超出范围，数量须为正整数，最大值为 1000000`,
    )
  }
  return number
}

export async function parseSalesFile(
  file: OfficeInputFile,
): Promise<SalesRow[]> {
  const table = await readTable(file)
  if (table.length < 2)
    throw new OfficeInputError('销售数据至少需要表头和一行记录')
  const headers = table[0]!.map((name) => aliases[name.trim()] ?? name.trim())
  if (
    new Set(headers).size !== headers.length ||
    columns.some((key) => !headers.includes(key))
  ) {
    throw new OfficeInputError(`缺少或重复销售字段：${columns.join(', ')}`)
  }
  const ids = new Set<string>()
  return table.slice(1).map((values, index) => {
    const rowNumber = index + 2
    if (values.length !== headers.length)
      throw new OfficeInputError(`第 ${rowNumber} 行列数与表头不同`)
    const field = (key: string) => values[headers.indexOf(key)]?.trim() ?? ''
    const orderId = textValue(
      field('orderId'),
      `第 ${rowNumber} 行订单编号`,
      80,
    )
    if (ids.has(orderId))
      throw new OfficeInputError(`第 ${rowNumber} 行订单编号重复：${orderId}`)
    ids.add(orderId)
    const date = field('date')
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    ) {
      throw new OfficeInputError(
        `第 ${rowNumber} 行日期必须为有效的 YYYY-MM-DD`,
      )
    }
    return {
      orderId,
      date,
      region: textValue(field('region'), `第 ${rowNumber} 行区域`, 40),
      product: textValue(field('product'), `第 ${rowNumber} 行产品`, 80),
      quantity: numeric(field('quantity'), `第 ${rowNumber} 行数量`, true),
      unitPrice: numeric(field('unitPrice'), `第 ${rowNumber} 行单价`),
      unitCost: numeric(field('unitCost'), `第 ${rowNumber} 行单位成本`),
    }
  })
}

export const cents = (number: number) => Math.round(number * 100)

export function summarizeSales(rows: SalesRow[]): SalesSummary {
  if (!rows.length || rows.length > OFFICE_LIMITS.rows)
    throw new OfficeInputError('销售记录数必须为 1–5000')
  const regions = new Map<string, SalesGroup>()
  const products = new Map<string, SalesGroup>()
  let revenue = 0
  let cost = 0
  let units = 0
  for (const row of rows) {
    const rowRevenue = cents(row.unitPrice) * row.quantity
    const rowCost = cents(row.unitCost) * row.quantity
    revenue += rowRevenue
    cost += rowCost
    units += row.quantity
    if (
      !Number.isSafeInteger(revenue) ||
      !Number.isSafeInteger(cost) ||
      revenue > 1e13 ||
      cost > 1e13
    ) {
      throw new OfficeInputError('金额总额超出安全计算范围')
    }
    for (const [map, name] of [
      [regions, row.region],
      [products, row.product],
    ] as const) {
      const group = map.get(name) ?? {
        name,
        orders: 0,
        units: 0,
        revenue: 0,
        cost: 0,
        profit: 0,
      }
      group.orders++
      group.units += row.quantity
      group.revenue += rowRevenue
      group.cost += rowCost
      group.profit += rowRevenue - rowCost
      map.set(name, group)
    }
  }
  const groups = (map: Map<string, SalesGroup>) =>
    Array.from(map.values())
      .map((group) => ({
        ...group,
        revenue: group.revenue / 100,
        cost: group.cost / 100,
        profit: group.profit / 100,
      }))
      .sort(
        (a, b) =>
          b.revenue - a.revenue || a.name.localeCompare(b.name, 'zh-CN'),
      )
  const dates = rows.map((row) => row.date).sort()
  return {
    orderCount: rows.length,
    units,
    revenue: revenue / 100,
    cost: cost / 100,
    profit: (revenue - cost) / 100,
    grossMargin: revenue === 0 ? null : (revenue - cost) / revenue,
    periodStart: dates[0]!,
    periodEnd: dates.at(-1)!,
    regions: groups(regions),
    products: groups(products),
  }
}
