<script setup lang="ts">
import { ref, watch } from 'vue'
import { changesApi } from '@/api/billing/changes-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingTime, changeLabel } from '@/utils/billing/change-labels'
const props = defineProps<{ owner: string }>()
const page = ref(1)
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource((signal) =>
  changesApi.history(props.owner, page.value, signal),
)
watch(page, () => {
  data.value = null
  void reload()
})
</script>
<template>
  <div class="form-stack">
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无换档记录', 'No plan changes')"
      @retry="reload"
    />
    <article v-for="r in data?.items ?? []" :key="r.id" class="stack">
      <h3>{{ r.fromPlanName }} → {{ r.toPlanName }}</h3>
      <dl class="billing-details">
        <dt>{{ tr('状态', 'Status') }}</dt>
        <dd>{{ changeLabel(r.state, tr) }}</dd>
        <dt>{{ tr('预约周期起点', 'Reserved period starts') }}</dt>
        <dd>{{ billingTime(r.effectiveAt) }}</dd>
        <dt>{{ tr('每周期价格 / 创作点', 'Price / credits per period') }}</dt>
        <dd>¥{{ r.priceFen / 100 }} / {{ r.points.toLocaleString() }}</dd>
        <dt>{{ tr('预约时间 / 办理人', 'Scheduled at / operator') }}</dt>
        <dd>{{ billingTime(r.createdAt) }} · {{ r.actorId }}</dd>
        <dt>{{ tr('预约原因', 'Reason') }}</dt>
        <dd>{{ r.reason }}</dd>
        <dt>{{ tr('预约单号', 'Reservation ID') }}</dt>
        <dd>{{ r.id }}</dd>
        <template v-if="r.bookedOperationId"
          ><dt>{{ tr('关联办理单', 'Membership operation') }}</dt>
          <dd>{{ r.bookedOperationId }}</dd></template
        >
        <template v-if="r.cancelledAt"
          ><dt>{{ tr('撤销时间 / 办理人', 'Cancelled at / operator') }}</dt>
          <dd>{{ billingTime(r.cancelledAt) }} · {{ r.cancelledBy }}</dd>
          <dt>{{ tr('撤销原因', 'Cancellation reason') }}</dt>
          <dd>{{ r.cancelReason }}</dd>
        </template>
        <template v-if="r.restoresChangeId"
          ><dt>{{ tr('恢复原档对应预约', 'Restores reservation') }}</dt>
          <dd>{{ r.restoresChangeId }}</dd></template
        >
      </dl>
    </article>
    <div v-if="page > 1 || data?.hasMore" class="toolbar">
      <el-button :disabled="loading || page === 1" @click="page--">{{
        tr('上一页', 'Previous')
      }}</el-button
      ><span>{{ page }}</span>
      <el-button :disabled="loading || !data?.hasMore" @click="page++">{{
        tr('下一页', 'Next')
      }}</el-button>
    </div>
  </div>
</template>
