<script setup lang="ts">
import { ref, watch } from 'vue'
import { pricingApi } from '@/api/billing/pricing-api'
import { catalogAdminApi } from '@/api/billing/catalog-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import type { PlanDraft } from '@/types/billing/pricing'
import type { PlanSeries } from '@/types/billing/catalog'
import { billingTime } from '@/utils/billing/change-labels'
const emit = defineEmits<{
  close: []
  resume: [draft: PlanDraft, series: PlanSeries | null]
}>()
const { tr } = usePreferences(),
  page = ref(1),
  size = ref(10),
  action = useMutation()
const { data, loading, error, reload } = useResource((signal) =>
  pricingApi.plans(
    { page: page.value, pageSize: size.value, search: '', state: 'draft' },
    signal,
  ),
)
watch([page, size], () => {
  data.value = null
  void reload()
})
async function resume(draft: PlanDraft) {
  let series: PlanSeries | null = null
  if (
    await action.run(async () => {
      series =
        (
          await catalogAdminApi.list(
            draft.scope,
            1,
            1,
            new AbortController().signal,
            true,
          )
        ).items[0] ?? null
    })
  )
    emit('resume', draft, series)
}
</script>
<template>
  <ManagementDialog
    readonly
    :model-value="true"
    :title="tr('商品草稿', 'Product drafts')"
    :busy="action.busy.value"
    :error="action.error.value"
    @update:model-value="!$event && emit('close')"
  >
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.total === 0"
      :empty-title="tr('暂无待发布草稿', 'No pending drafts')"
      @retry="reload"
    />
    <article v-for="row in data?.items" :key="row.id" class="panel form-stack">
      <strong>{{ row.payload.terms.name }} · {{ row.scope }}</strong
      ><span
        >{{ tr('草稿修订', 'Draft revision') }} {{ row.revision }} · ¥{{
          row.payload.terms.priceFen / 100
        }}
        · {{ row.payload.terms.points }} {{ tr('点', 'credits') }}</span
      ><small>{{ billingTime(row.createdAt) }}</small
      ><el-button :disabled="action.busy.value" @click="resume(row)">{{
        tr('继续编辑', 'Resume editing')
      }}</el-button>
    </article>
    <ManagementPagination
      v-model:current-page="page"
      v-model:page-size="size"
      :page-sizes="[10, 20, 50]"
      :total="data?.total ?? 0"
      :loading="loading"
    />
  </ManagementDialog>
</template>
