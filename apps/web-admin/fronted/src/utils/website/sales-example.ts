/** 图表在构建时读取下载使用的同一个公开 CSV，先以元汇总，再换算为万元。 */
export const salesRegions = [
  ['华东', 'East'],
  ['华南', 'South'],
  ['华北', 'North'],
  ['西部', 'West'],
] as const

const byMonth = new Map<number, number[]>()
for (const row of __PUBLIC_SALES_EXAMPLE__.trim().split(/\r?\n/u).slice(1)) {
  const [label, area, revenue] = row.split(',')
  const month = Number(label?.replace(/月$/u, ''))
  const region = salesRegions.findIndex(([chinese]) => chinese === area)
  const amount = Number(revenue)
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    region < 0 ||
    !revenue ||
    !Number.isSafeInteger(amount)
  )
    throw new Error('官网销售样表包含无法识别的月份、区域或金额')
  const amounts = byMonth.get(month) ?? salesRegions.map(() => 0)
  amounts[region] = (amounts[region] ?? 0) + amount
  byMonth.set(month, amounts)
}
const monthName = new Intl.DateTimeFormat('en', {
  month: 'short',
  timeZone: 'UTC',
})
export const salesMonths = [...byMonth]
  .sort(([a], [b]) => a - b)
  .map(([month, amounts]) => ({
    month: [
      `${month} 月`,
      monthName.format(Date.UTC(2000, month - 1)),
    ] as const,
    sales: amounts.map((amount) => amount / 10000),
    total: amounts.reduce((sum, amount) => sum + amount, 0) / 10000,
  }))
export const salesQuarter = salesMonths.reduce(
  (sum, item) => sum + item.total,
  0,
)
export const peakMonthSales = Math.max(...salesMonths.map((item) => item.total))
export const salesExampleDownload = '/images/website/sales-example.csv'
