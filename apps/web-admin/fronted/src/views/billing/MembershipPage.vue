<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { membershipApi } from '@/api/billing/membership-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingLabel } from '@/utils/billing/labels'

import { billingTime, changeLabel } from '@/utils/billing/change-labels'
import CreditCards from './components/CreditCards.vue'
import CreditEntries from './components/CreditEntries.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource(membershipApi.wallet)
const route = useRoute()
const router = useRouter()
const tab = ref('entries')
const refreshKey = ref(0)
function refresh() {
  void reload()
  refreshKey.value++
}
</script>
<template>
  <section class="page settings-page billing-page">
    <PageHeader :title="tr('我的会员与额度', 'My membership and credits')" />
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data"
      @retry="refresh"
    />
    <template v-if="data">
      <SettingsCard
        :title="
          data.subscription?.plan.name ??
          (data.planChange?.state === 'due'
            ? tr('会员已到期', 'Membership expired')
            : tr('尚未开通会员', 'No active membership'))
        "
        :description="
          data.subscription
            ? tr('会员已购至 ', 'Membership booked through ') +
              billingTime(data.subscription.endsAt)
            : tr(
                '办公与娱乐共用此账号的创作点。',
                'Your credits are shared across Office and Entertainment.',
              )
        "
      >
        <template #action>
          <el-button :disabled="loading" @click="refresh">{{
            tr('刷新', 'Refresh')
          }}</el-button>
          <el-button
            type="primary"
            @click="
              router.push({
                path: '/account/plans',
                query: { product: route.query.product },
              })
            "
            >{{ tr('选购会员', 'Browse plans') }}</el-button
          >
        </template>
        <div class="billing-metrics">
          <div>
            <span>{{ tr('可用创作点', 'Available credits') }}</span
            ><strong>{{
              data.unlimited
                ? tr('无限额度', 'Unlimited')
                : data.availablePoints.toLocaleString()
            }}</strong>
            <small v-if="data.cardPoints"
              >{{ tr('其中额度卡', 'From cards') }}
              {{ data.cardPoints.toLocaleString() }}
              {{ tr('点', 'credits') }}</small
            >
          </div>
          <div>
            <span>{{ tr('任务占用', 'Held by tasks') }}</span
            ><strong>{{ data.heldPoints.toLocaleString() }}</strong>
          </div>
          <div>
            <span>{{
              tr(
                '未来 ' + data.expiringDays + ' 天到期',
                'Expiring within ' + data.expiringDays + ' days',
              )
            }}</span
            ><strong>{{ data.expiringPoints.toLocaleString() }}</strong>
          </div>
        </div>
        <p
          v-if="
            data.subscription?.nextBookedPlan &&
            (data.planChange?.state !== 'booked' ||
              data.subscription.nextBookedPlan.startsAt !==
                data.planChange.effectiveAt)
          "
        >
          {{ tr('已购的下个档位', 'Next booked tier') }} ·
          {{ data.subscription.nextBookedPlan.name }} ·
          {{ billingTime(data.subscription.nextBookedPlan.startsAt) }}
        </p>
        <div v-if="data.planChange" class="form-stack">
          <h3>{{ tr('换档安排', 'Plan change') }}</h3>
          <div>
            {{ data.planChange.fromPlanName }} →
            {{ data.planChange.toPlanName }} ·
            {{ changeLabel(data.planChange.state, tr) }}
          </div>
          <small
            >{{ tr('预约周期起点', 'Reserved period starts') }} ·
            {{ billingTime(data.planChange.effectiveAt) }}</small
          >
          <small v-if="data.planChange.state !== 'booked'">{{
            tr(
              '完成会员办理后，按新周期发放创作点。',
              'Credits are granted for the new period once the membership is booked.',
            )
          }}</small>
        </div>
        <p v-if="data.subscription?.nextGrantAt">
          {{ tr('下次发放', 'Next grant') }} ·
          {{ billingTime(data.subscription.nextGrantAt) }}
        </p>
        <small class="billing-note"
          >{{ tr('余额更新于', 'Balance as of') }}
          {{ billingTime(data.asOf) }}</small
        >
      </SettingsCard>
      <SettingsCard :title="tr('额度记录', 'Credit activity')">
        <el-tabs v-model="tab">
          <el-tab-pane :label="tr('额度明细', 'Ledger')" name="entries"
            ><CreditEntries :key="refreshKey"
          /></el-tab-pane>
          <el-tab-pane :label="tr('我的额度卡', 'My credit cards')" name="cards"
            ><CreditCards v-if="tab === 'cards'" :key="refreshKey"
          /></el-tab-pane>
          <el-tab-pane :label="tr('来源批次', 'Credit lots')" name="lots">
            <ResourceStatus
              :empty="!data.lots.length"
              :empty-title="
                tr('没有可用或占用中的额度批次', 'No available or held lots')
              "
            />
            <ul v-if="data.lots.length" class="billing-rows">
              <li v-for="lot in data.lots" :key="lot.id">
                <div>
                  <strong>{{ billingLabel(lot.sourceKey, tr) }}</strong
                  ><small
                    >{{ tr('到期', 'Expires') }} ·
                    {{ billingTime(lot.expiresAt) }}</small
                  >
                </div>
                <div>
                  <span
                    >{{ tr('可用', 'Available') }}
                    {{ lot.availablePoints.toLocaleString() }}</span
                  ><small
                    >{{ tr('占用', 'Held') }}
                    {{ lot.held.toLocaleString() }}</small
                  >
                </div>
              </li>
            </ul>
            <small v-if="data.hasMoreLots" class="billing-note">{{
              tr(
                '按到期顺序展示前 20 批，历史发放可在额度明细中查询。',
                'Showing the first 20 lots by expiry. See the ledger for all grants.',
              )
            }}</small>
          </el-tab-pane>
        </el-tabs>
      </SettingsCard>
    </template>
  </section>
</template>
