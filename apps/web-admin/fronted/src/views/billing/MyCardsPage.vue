<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { membershipApi } from '@/api/billing/membership-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingTime } from '@/utils/billing/change-labels'
import CreditCards from './components/CreditCards.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource(membershipApi.wallet)
</script>
<template>
  <section class="page settings-page ticket-page">
    <PageHeader :title="tr('我的额度卡', 'My credit cards')" />
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data"
      @retry="reload"
    />
    <div v-if="data" class="ticket-wallet-summary">
      <div class="ticket-wallet-plan">
        <strong>{{
          data.unlimited
            ? tr('无限额度', 'Unlimited credits')
            : (data.subscription?.plan.name ??
              tr('普通账户', 'Standard account'))
        }}</strong>
        <div v-if="data.quota && !data.unlimited" class="ticket-quota-lines">
          <div
            :title="
              tr('重置时间 ', 'Resets ') + billingTime(data.quota.weekEndsAt)
            "
          >
            <span
              >{{ tr('本周剩余', 'Week remaining') }}
              <b
                >{{ data.quota.weeklyRemaining.toLocaleString() }} /
                {{ data.quota.weeklyLimit.toLocaleString() }}</b
              >
              {{ tr('点', 'credits') }}</span
            >
            <progress
              :value="data.quota.weeklyRemaining"
              :max="data.quota.weeklyLimit"
              :aria-label="tr('本周剩余', 'Week remaining')"
            />
          </div>
          <div
            :title="
              tr('重置时间 ', 'Resets ') + billingTime(data.quota.monthEndsAt)
            "
          >
            <span
              >{{ tr('本月剩余', 'Month remaining') }}
              <b
                >{{ data.quota.monthlyRemaining.toLocaleString() }} /
                {{ data.quota.monthlyLimit.toLocaleString() }}</b
              >
              {{ tr('点', 'credits') }}</span
            >
            <progress
              :value="data.quota.monthlyRemaining"
              :max="data.quota.monthlyLimit"
              :aria-label="tr('本月剩余', 'Month remaining')"
            />
          </div>
        </div>
      </div>
      <div class="ticket-wallet-total">
        <span>{{ tr('普通额度', 'Regular credits') }}</span
        ><strong
          >{{ (data.ordinaryPoints ?? 0).toLocaleString() }}
          <small>{{ tr('点', 'credits') }}</small></strong
        >
      </div>
      <div class="ticket-wallet-total">
        <span>{{ tr('卡内可用', 'Available on cards') }}</span
        ><strong
          >{{ (data.cardPoints ?? 0).toLocaleString() }}
          <small>{{ tr('点', 'credits') }}</small></strong
        >
      </div>
    </div>
    <CreditCards />
  </section>
</template>
