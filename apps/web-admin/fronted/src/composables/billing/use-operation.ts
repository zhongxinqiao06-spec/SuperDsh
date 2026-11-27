import { computed, ref, watch } from 'vue'
import { membershipApi } from '@/api/billing/membership-api'
import { operationsApi } from '@/api/billing/operations-api'
import { useMutation } from '@/composables/use-mutation'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import type {
  BillingAccount,
  BillingAction,
  BillingOperation,
  OperationInput,
  PaymentMode,
} from '@/types/billing/operations'
import { createUuid } from '@/utils/uuid'
import { awaitsBooking } from '@/utils/billing/change-labels'

/** 保留不确定提交的原单，确认页锁定字段；显式返回编辑后创建新的预览。 */
export function useOperation(
  account: BillingAccount,
  initial: BillingAction,
  saved: (receipt: BillingOperation) => void,
) {
  const auth = useAuthStore()
  const catalog = useResource(membershipApi.catalog)
  const mutation = useMutation()
  const action = ref(initial),
    reason = ref(''),
    points = ref<number>(),
    days = ref(initial === 'card' ? 365 : 30)
  const cardId = ref('')
  const cardTypes = computed(() => catalog.data.value?.cardTypes ?? [])
  const card = computed(() =>
    cardTypes.value.find((c) => c.id === cardId.value),
  )
  watch(
    cardTypes,
    (items) => {
      if (!items.some((c) => c.id === cardId.value))
        cardId.value = items[0]?.id ?? ''
    },
    { immediate: true },
  )
  watch(card, (value) => {
    if (action.value === 'card' && value) days.value = value.validDays
  })
  watch(action, (next, old) => {
    if (next === 'card') days.value = card.value?.validDays ?? 365
    else if (old === 'card') days.value = 30
  })
  const payment = ref<PaymentMode>('complimentary'),
    receipt = ref(''),
    amount = ref('')
  const planId = ref(''),
    preview = ref<BillingOperation | null>(null)
  const member = computed(() => ['open', 'renew'].includes(action.value))
  const manual = computed(() =>
    ['gift', 'compensation', 'card'].includes(action.value),
  )
  const plans = computed(
    () =>
      catalog.data.value?.items.filter((p) => {
        if (!member.value) return p.kind === 'addon'
        if (p.kind !== 'membership') return false
        if (awaitsBooking(account.planChange))
          return p.id === account.planChange?.toVersionId
        return (
          action.value !== 'renew' ||
          p.sku === (account.lastBookedSku ?? account.planSku)
        )
      }) ?? [],
  )
  const activePlan = computed(() =>
    plans.value.find((p) => p.id === planId.value),
  )
  const selectedPayment = computed(() =>
    action.value === 'topup'
      ? 'offline'
      : manual.value
        ? 'complimentary'
        : payment.value,
  )
  watch(
    [plans, action],
    () => {
      planId.value =
        (member.value &&
        account.planId &&
        plans.value.some((p) => p.id === account.planId)
          ? account.planId
          : plans.value[0]?.id) ?? ''
    },
    { immediate: true },
  )
  const canReceipt = auth.can('billing.receipts.record')
  const moneyValid = computed(
    () =>
      /^\d{1,8}(\.\d{1,2})?$/.test(amount.value.trim()) &&
      Math.round(Number(amount.value) * 100) === activePlan.value?.priceFen,
  )
  const valid = computed(
    () =>
      !!reason.value.trim() &&
      (manual.value
        ? (action.value === 'card'
            ? !!card.value
            : Number.isInteger(points.value) && (points.value ?? 0) > 0) &&
          Number.isInteger(days.value) &&
          days.value > 0
        : !!activePlan.value) &&
      (selectedPayment.value !== 'offline' ||
        (canReceipt && !!receipt.value.trim() && moneyValid.value)),
  )
  let lastInput = '',
    key = ''
  function edit() {
    preview.value = null
    lastInput = ''
    mutation.error.value = ''
  }
  async function submit() {
    if (mutation.busy.value) return
    if (preview.value) {
      const original = preview.value
      let confirmed: BillingOperation | undefined
      if (
        (await mutation.run(async () => {
          confirmed = await operationsApi.confirm(original)
        })) &&
        confirmed
      )
        saved(confirmed)
      return
    }
    if (!valid.value) return
    const input: Omit<OperationInput, 'businessKey'> = {
      userId: account.userId,
      action: action.value,
      reason: reason.value.trim(),
      payment: selectedPayment.value,
      ...(manual.value
        ? {
            points: action.value === 'card' ? card.value?.points : points.value,
            ...(action.value === 'card' && card.value
              ? { cardTypeId: card.value.id, cardRevision: card.value.revision }
              : {}),
            validDays: days.value,
          }
        : { planVersionId: planId.value }),
      ...(selectedPayment.value === 'offline'
        ? {
            receipt: receipt.value.trim(),
            receivedFen: Math.round(Number(amount.value) * 100),
          }
        : {}),
    }
    await mutation.run(async () => {
      const fingerprint = JSON.stringify(input)
      if (fingerprint !== lastInput) {
        key = createUuid()
        lastInput = fingerprint
      }
      preview.value = await operationsApi.preview({
        ...input,
        businessKey: key,
      })
    })
  }
  return {
    catalog,
    cardId,
    cardTypes,
    mutation,
    action,
    reason,
    points,
    days,
    payment,
    receipt,
    amount,
    planId,
    preview,
    plans,
    activePlan,
    valid,
    manual,
    member,
    selectedPayment,
    canReceipt,
    edit,
    submit,
  }
}
