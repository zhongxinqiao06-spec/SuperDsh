/** 按当前浏览器地区展示服务端时间；缺失或非法时间以占位符显示。 */
export function dateTimeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString()
}

/** 列表时间按本地地区格式拆成稳定的日期与时间两行，非法输入不抛出。 */
export function dateTimeParts(value: string | null | undefined): {
  date: string
  time: string
  full: string
} {
  const date = value ? new Date(value) : undefined
  if (!date || Number.isNaN(date.valueOf()))
    return { date: '—', time: '', full: '—' }
  return {
    date: date.toLocaleDateString(),
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    full: date.toLocaleString(),
  }
}
