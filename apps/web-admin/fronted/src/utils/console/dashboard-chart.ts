import type { DashboardOverview } from '@/types/service/system'

/** 将真实日期序列换算为 SVG 坐标；非法数值不绘制，空序列不伪造数据。 */
export function dashboardChart(
  series: DashboardOverview['series'],
  keys: string[],
) {
  const width = 680,
    height = 300,
    left = 42,
    right = 16,
    top = 16,
    bottom = 36
  const values = series.flatMap((row) =>
    keys
      .map((key) => row[key])
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      ),
  )
  const maximum = values.reduce(
      (largest, value) => Math.max(largest, value),
      1,
    ),
    baseline = height - bottom,
    plotWidth = width - left - right,
    plotHeight = baseline - top
  const x = (index: number) =>
    left +
    (series.length < 2
      ? plotWidth / 2
      : (index * plotWidth) / (series.length - 1))
  return {
    width,
    height,
    left,
    right: width - right,
    baseline,
    ticks: Array.from({ length: 5 }, (_, index) => ({
      y: top + (index * plotHeight) / 4,
      value: (maximum * (4 - index)) / 4,
    })),
    dates: series
      .map((row, index) => ({ label: row.date, x: x(index), index }))
      .filter(
        ({ index }) =>
          index === 0 ||
          index === series.length - 1 ||
          index % Math.max(1, Math.ceil(series.length / 5)) === 0,
      ),
    lines: keys.map((key) => {
      const points = series.flatMap((row, index) => {
        const value = row[key]
        return typeof value === 'number' && Number.isFinite(value)
          ? [
              {
                x: x(index),
                y: baseline - (value / maximum) * plotHeight,
                date: row.date,
                value,
              },
            ]
          : []
      })
      return {
        key,
        points,
        stroke: points.map((point) => `${point.x},${point.y}`).join(' '),
        area: points.length
          ? `${points[0]!.x},${baseline} ${points.map((point) => `${point.x},${point.y}`).join(' ')} ${points.at(-1)!.x},${baseline}`
          : '',
      }
    }),
  }
}
