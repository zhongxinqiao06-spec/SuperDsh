<script setup lang="ts">
import type { BillingAccount, BillingAction } from '@/types/billing/operations'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
/** 以当前账号账务权限和收件人状态展示可办理的三类权益。 */
defineProps<{ account: BillingAccount }>()
defineEmits<{ operate: [account: BillingAccount, action: BillingAction] }>()
const auth = useAuthStore()
const { tr } = usePreferences()
</script>
<template>
  <template v-if="!account.disabled && auth.can('billing.read')">
    <el-button
      v-if="auth.can('billing.subscriptions.manage')"
      link
      @click="
        $emit('operate', account, account.state === 'active' ? 'renew' : 'open')
      "
    >
      {{
        account.state === 'active'
          ? tr('续期', 'Renew')
          : tr('发放会员', 'Grant membership')
      }}
    </el-button>
    <template v-if="auth.can('billing.adjustments.create')">
      <el-button link @click="$emit('operate', account, 'gift')">{{
        tr('加额度', 'Add credits')
      }}</el-button>
      <el-button link @click="$emit('operate', account, 'card')">{{
        tr('发额度卡', 'Issue card')
      }}</el-button>
    </template>
  </template>
</template>
