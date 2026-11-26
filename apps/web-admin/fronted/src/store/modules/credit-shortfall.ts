import { shallowRef } from 'vue'

/** 只接受扣点接口返回的数值，关闭推荐后保留原制作页面与草稿。 */
export const creditShortfall = shallowRef<{
  requiredPoints: number
  availablePoints: number
} | null>(null)

export function showCreditShortfall(value: unknown) {
  if (!value || typeof value !== 'object') return
  const { requiredPoints, availablePoints } = value as Record<string, unknown>
  if (
    typeof requiredPoints === 'number' &&
    Number.isSafeInteger(requiredPoints) &&
    typeof availablePoints === 'number' &&
    Number.isSafeInteger(availablePoints) &&
    availablePoints >= 0 &&
    requiredPoints > availablePoints
  )
    creditShortfall.value = { requiredPoints, availablePoints }
}
