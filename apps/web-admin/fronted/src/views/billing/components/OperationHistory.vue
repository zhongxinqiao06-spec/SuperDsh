<script setup lang="ts">
import { ref, watch } from 'vue'
import PlanChangeHistory from './PlanChangeHistory.vue'
import { operationsApi } from '@/api/billing/operations-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingLabel } from '@/utils/billing/labels'
import { billingTime } from '@/utils/billing/change-labels'
import type { BillingAccount } from '@/types/billing/operations'
const props = defineProps<{ account: BillingAccount }>()
defineEmits<{ close: [] }>()
const page = ref(1)
const tab = ref('operations')
const summary = useResource((signal) =>
  operationsApi.summary(props.account.userId, signal),
)
const { tr } = usePreferences()
const { data, error, loading, reload } = useResource((signal) =>
  operationsApi.history(props.account.userId, page.value, signal),
)
watch(page, () => {
  data.value = null
  void reload()
})
</script>
<template>
  <ManagementDialog
    readonly
    :model-value="true"
    :title="tr('历史办理', 'Operation history')"
    @update:model-value="!$event && $emit('close')"
    ><div class="form-stack">
      <strong
        >{{ account.displayName || account.username }} ·
        {{ account.username }}</strong
      >
      <ResourceStatus
        :loading="summary.loading.value"
        :error="summary.error.value"
        @retry="summary.reload"
      />
      <dl v-if="summary.data.value" class="billing-details">
        <dt>{{ tr('可用 / 占用', 'Available / held') }}</dt>
        <dd>
          {{ summary.data.value.availablePoints }} /
          {{ summary.data.value.heldPoints }}
        </dd>
        <dt>{{ tr('7 天内到期', 'Expiring in 7 days') }}</dt>
        <dd>{{ summary.data.value.expiringPoints }}</dd>
        <template v-if="summary.data.value.subscription?.nextGrantAt"
          ><dt>{{ tr('下次发放', 'Next grant') }}</dt>
          <dd>
            {{ billingTime(summary.data.value.subscription.nextGrantAt) }}
          </dd></template
        >
      </dl>
      <el-tabs v-model="tab"
        ><el-tab-pane :label="tr('办理记录', 'Operations')" name="operations">
          <ResourceStatus
            :loading="loading"
            :error="error"
            :empty="data?.items.length === 0"
            :empty-title="tr('暂无办理记录', 'No operations')"
            @retry="reload"
          />
          <article v-for="r in data?.items ?? []" :key="r.id" class="stack">
            <h3>
              {{ billingLabel(r.quote.action, tr) }} ·
              {{ r.quote.planName ?? tr('创作点', 'Credits') }}
            </h3>
            <dl class="billing-details">
              <dt>{{ tr('办理时间', 'Confirmed') }}</dt>
              <dd>{{ billingTime(r.confirmedAt) }}</dd>
              <dt>{{ tr('生效至到期', 'Effective period') }}</dt>
              <dd>
                {{ billingTime(r.quote.startsAt) }} —
                {{ billingTime(r.quote.endsAt) }}
              </dd>
              <dt>{{ tr('发放点数', 'Credits') }}</dt>
              <dd>{{ r.quote.points }}</dd>
              <dt>{{ tr('实收', 'Amount received') }}</dt>
              <dd>¥{{ r.quote.receivedFen / 100 }}</dd>
              <template v-if="r.receipt"
                ><dt>{{ tr('收款凭证号', 'Receipt reference') }}</dt>
                <dd>{{ r.receipt }}</dd></template
              >
              <dt>{{ tr('办理原因', 'Reason') }}</dt>
              <dd>{{ r.reason }}</dd>
              <dt>{{ tr('办理人 ID', 'Operator ID') }}</dt>
              <dd>{{ r.actorId }}</dd>
              <dt>{{ tr('办理单号', 'Operation ID') }}</dt>
              <dd>{{ r.id }}</dd>
            </dl>
          </article>
          <div class="toolbar">
            <el-button :disabled="loading || page === 1" @click="page--">{{
              tr('上一页', 'Previous')
            }}</el-button
            ><span>{{ page }}</span
            ><el-button :disabled="loading || !data?.hasMore" @click="page++">{{
              tr('下一页', 'Next')
            }}</el-button>
          </div> </el-tab-pane
        ><el-tab-pane
          :label="tr('换档记录', 'Plan changes')"
          name="changes"
          lazy
          ><PlanChangeHistory :owner="account.userId" /></el-tab-pane
      ></el-tabs></div
  ></ManagementDialog>
</template>
