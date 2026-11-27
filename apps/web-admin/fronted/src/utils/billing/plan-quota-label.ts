import type { Plan } from '@/types/billing/membership'

/** 价格期限与额度周期分别显示；年会员的额度仍按月重置。 */
export function planQuotaLabel(
  plan: Pick<Plan, 'kind' | 'weeklyPoints' | 'points'>,
  tr: (zh: string, en: string) => string,
): string {
  const points = plan.points.toLocaleString()
  if (plan.kind === 'addon') return tr(points + ' 点', points + ' credits')
  const week = plan.weeklyPoints?.toLocaleString() ?? '—'
  return tr(
    '每周 ' + week + ' 点 · 每月 ' + points + ' 点',
    'Weekly: ' + week + ' credits · Monthly: ' + points + ' credits',
  )
}
