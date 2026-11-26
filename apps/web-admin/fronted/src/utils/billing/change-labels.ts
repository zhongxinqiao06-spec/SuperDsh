import type { ChangeState, ChangeSummary } from '@/types/billing/changes'

const labels: Record<ChangeState, [string, string]> = {
  scheduled: ['已预约，待办理', 'Scheduled, awaiting renewal'],
  due: ['已到期，待办理', 'Due, awaiting activation'],
  booked: ['已办理，待周期开始', 'Booked, awaiting start'],
  effective: ['已生效', 'Effective'],
  cancelled: ['已撤销', 'Cancelled'],
}

export function changeLabel(
  state: ChangeState,
  tr: (zh: string, en: string) => string,
) {
  return tr(...labels[state])
}

export function awaitsBooking(change?: ChangeSummary | null) {
  return change?.state === 'scheduled' || change?.state === 'due'
}

/** 将服务端的绝对时刻统一显示为北京时间。 */
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
export function billingTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? '—'
    : formatter.format(date) + ' (UTC+8)'
}
