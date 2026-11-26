import { computed, ref } from 'vue'
import { changesApi } from '@/api/billing/changes-api'
import { useMutation } from '@/composables/use-mutation'
import type { Plan } from '@/types/billing/membership'
import type { BillingAccount } from '@/types/billing/operations'
import { ApiError } from '@/utils/errors'
import { createUuid } from '@/utils/uuid'

/** 预约与撤销共用会员修订号；同一份草稿在结果不确定时保留业务号。 */
export function usePlanChange(
  props: {
    account: BillingAccount
    plans: Plan[]
    mode: 'schedule' | 'cancel'
  },
  completed: (outcome: 'saved' | 'effective') => void,
) {
  const mutation = useMutation()
  const reason = ref(''),
    target = ref('')
  const choices = computed(() =>
    props.plans.filter(
      (p) => p.kind === 'membership' && p.sku !== props.account.lastBookedSku,
    ),
  )
  const plan = computed(() => choices.value.find((p) => p.id === target.value))
  const schedule = computed(() => props.mode === 'schedule')
  const booked = computed(() => props.account.planChange?.state === 'booked')
  const valid = computed(
    () =>
      !!reason.value.trim() &&
      (schedule.value ? !!plan.value : !!props.account.planChange),
  )
  let fingerprint = '',
    key = ''
  async function submit() {
    if (!valid.value || mutation.busy.value) return
    const input = {
      expectedRevision: props.account.revision,
      reason: reason.value.trim(),
    }
    const signature = JSON.stringify([input, target.value])
    if (fingerprint !== signature) {
      key = createUuid()
      fingerprint = signature
    }
    const command = { ...input, businessKey: key }
    let effective = false
    const ok = await mutation.run(async () => {
      try {
        if (schedule.value)
          await changesApi.schedule(props.account.userId, {
            ...command,
            planVersionId: target.value,
          })
        else if (props.account.planChange)
          await changesApi.cancel(
            props.account.userId,
            props.account.planChange.id,
            command,
          )
      } catch (error) {
        effective =
          error instanceof ApiError && error.code === 'plan_change_effective'
        throw error
      }
    })
    if (ok) completed('saved')
    else if (effective && mutation.error.value) completed('effective')
  }
  return { schedule, booked, valid, choices, target, reason, mutation, submit }
}
