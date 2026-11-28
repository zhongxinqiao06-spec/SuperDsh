<script setup lang="ts">
import { computed } from 'vue'
import MemberActionMenu from '@/components/management/MemberActionMenu.vue'
import type { BillingAccount, BillingAction } from '@/types/billing/operations'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
const props = defineProps<{ account: BillingAccount }>()
const emit = defineEmits<{
  operate: [account: BillingAccount, action: BillingAction]
}>()
const auth = useAuthStore(),
  { tr } = usePreferences()
const actions = computed(() => {
  const items: { key: BillingAction; label: string }[] = []
  if (props.account.disabled || !auth.can('billing.read')) return items
  if (auth.can('billing.subscriptions.manage')) {
    const active = props.account.state === 'active'
    items.push({
      key: active ? 'renew' : 'open',
      label: active
        ? tr('续期会员', 'Renew membership')
        : tr('开通会员', 'Grant membership'),
    })
  }
  if (auth.can('billing.adjustments.create'))
    items.push(
      { key: 'gift', label: tr('加普通额度', 'Add regular credits') },
      { key: 'card', label: tr('发额度卡', 'Issue credit card') },
    )
  return items
})
function select(key: string) {
  const a = actions.value.find((a) => a.key === key)
  if (a) emit('operate', props.account, a.key)
}
</script>
<template>
  <MemberActionMenu
    :owner="account.displayName || account.username"
    :label="tr('办理权益', 'Manage benefits')"
    :actions="actions"
    emphasis
    @action="select"
  />
</template>
