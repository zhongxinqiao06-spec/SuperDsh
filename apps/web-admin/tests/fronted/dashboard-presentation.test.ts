import { describe, expect, it } from 'vitest'
import { dashboardChart } from '@/utils/console/dashboard-chart'

describe('运营趋势展示坐标', () => {
  it('空数据和非法值不产生虚构数据点', () => {
    expect(dashboardChart([], ['dau']).lines[0]?.points).toEqual([])
    const chart = dashboardChart(
      [
        { date: '2026-01-01', dau: Number.NaN },
        { date: '2026-01-02', dau: 'unknown' },
      ],
      ['dau'],
    )
    expect(chart.lines[0]?.points).toEqual([])
    expect(chart.lines[0]?.area).toBe('')
    expect(chart.ticks.every((tick) => Number.isFinite(tick.y))).toBe(true)
  })
  it('单日零值位于图表中心，避免除零与误导的上升趋势', () => {
    const chart = dashboardChart([{ date: '2026-01-01', dau: 0 }], ['dau'])
    const point = chart.lines[0]?.points[0]
    expect(point?.x).toBe((chart.left + chart.right) / 2)
    expect(point?.y).toBe(chart.baseline)
    expect(point?.value).toBe(0)
  })
  it('多项指标共用纵轴且保留每个原始值与首末日期', () => {
    const chart = dashboardChart(
      [
        { date: '2026-01-01', dau: 1, totalMessages: 10 },
        { date: '2026-01-02', dau: 4, totalMessages: 20 },
      ],
      ['dau', 'totalMessages'],
    )
    expect(chart.lines[0]?.points.map((point) => point.value)).toEqual([1, 4])
    expect(chart.lines[1]?.points.map((point) => point.value)).toEqual([10, 20])
    expect(chart.ticks[0]?.value).toBe(20)
    expect(chart.dates.map((point) => point.x)).toEqual([
      chart.left,
      chart.right,
    ])
  })
})
