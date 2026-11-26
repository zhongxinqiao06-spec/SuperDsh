<script setup lang="ts">
import { ref, watch } from 'vue'
import { catalogAdminApi } from '@/api/billing/catalog-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import type { PlanSeries } from '@/types/billing/catalog'
import { billingTime } from '@/utils/billing/change-labels'
const props = defineProps<{ series: PlanSeries }>()
defineEmits<{ close: [] }>()
const { tr } = usePreferences()
const page = ref(1),
  size = 10
const { data, loading, error, reload } = useResource((signal) =>
  catalogAdminApi.history(props.series.latest.sku, page.value, size, signal),
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
    :title="tr('套餐版本历史', 'Plan version history')"
    @update:model-value="!$event && $emit('close')"
  >
    <strong
      >{{ series.current?.name ?? series.latest.name }} ·
      {{ series.latest.sku }}</strong
    >
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      @retry="reload"
    />
    <article v-for="v in data?.items ?? []" :key="v.id" class="stack">
      <h3>v{{ v.revision }} · {{ v.name }}</h3>
      <dl class="billing-details">
        <dt>{{ tr('发布内容', 'Listing') }}</dt>
        <dd>
          {{ v.listed ? tr('上架', 'Listed') : tr('下架', 'Delisted') }} · ¥{{
            v.priceFen / 100
          }}
          · {{ v.points.toLocaleString() }} {{ tr('点', 'credits') }} /
          {{ v.termUnit === 'year' ? tr('年', 'year') : tr('月', 'month') }}
        </dd>
        <dt>
          {{
            v.withdrawnAt
              ? tr('原定生效', 'Originally scheduled')
              : tr('生效时间', 'Effective time')
          }}
        </dt>
        <dd>{{ billingTime(v.effectiveAt) }}</dd>
        <template v-if="v.publishedBy"
          ><dt>{{ tr('发布时间 / 操作人', 'Published at / by') }}</dt>
          <dd>{{ billingTime(v.publishedAt) }} · {{ v.publishedBy }}</dd>
          <dt>{{ tr('发布原因', 'Reason') }}</dt>
          <dd>{{ v.publishReason }}</dd></template
        >
        <template v-if="v.withdrawnAt"
          ><dt>{{ tr('已撤回', 'Withdrawn') }}</dt>
          <dd>{{ billingTime(v.withdrawnAt) }} · {{ v.withdrawnBy }}</dd>
          <dt>{{ tr('撤回原因', 'Withdrawal reason') }}</dt>
          <dd>{{ v.withdrawReason }}</dd></template
        >
      </dl>
    </article>
    <ManagementPagination
      v-if="(data?.total ?? 0) > size"
      v-model:current-page="page"
      :page-size="size"
      :total="data?.total ?? 0"
      :loading="loading"
    />
  </ManagementDialog>
</template>
