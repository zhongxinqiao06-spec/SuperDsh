<script setup lang="ts">
import { ref, watch } from 'vue'
import { catalogAdminApi } from '@/api/billing/catalog-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import DataTable from '@/components/management/DataTable.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import type { PlanSeries } from '@/types/billing/catalog'
import { billingTime } from '@/utils/billing/change-labels'
import CatalogEditor from './components/CatalogEditor.vue'
import PlanDraftDirectory from './components/PlanDraftDirectory.vue'
import type { PlanDraft } from '@/types/billing/pricing'
import CatalogHistory from './components/CatalogHistory.vue'
import '@/assets/styles/billing.css'

const auth = useAuthStore(),
  { tr } = usePreferences()
const page = ref(1),
  size = ref(10),
  draft = ref(''),
  search = ref(''),
  notice = ref('')
const draftsOpen = ref(false)
const editor = ref<{
    series: PlanSeries | null
    withdraw: boolean
    stored?: PlanDraft
  } | null>(null),
  history = ref<PlanSeries | null>(null)
const { data, error, loading, reload } = useResource((signal) =>
  catalogAdminApi.list(search.value, page.value, size.value, signal),
)
watch([page, size, search], () => {
  data.value = null
  void reload()
})
function filter() {
  if (page.value === 1 && search.value === draft.value.trim()) {
    void reload()
    return
  }
  page.value = 1
  search.value = draft.value.trim()
}
function complete(draftOnly: boolean) {
  notice.value = draftOnly
    ? tr('套餐草稿已保存', 'Plan draft saved')
    : editor.value?.withdraw
      ? tr('已撤回待生效版本', 'Scheduled version withdrawn')
      : tr('套餐版本已发布', 'Plan version published')
  editor.value = null
  void reload()
}
function refresh() {
  editor.value = null
  void reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('套餐版本管理', 'Plan versions')" />
    <FilterBar class="toolbar billing-directory-filter" @submit="filter"
      ><el-input
        v-model="draft"
        :aria-label="tr('搜索商品编码', 'Search product code')"
        :placeholder="tr('搜索商品编码', 'Search product code')"
        clearable
      />
      <el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button>
      <el-button @click="reload()">{{ tr('刷新', 'Refresh') }}</el-button>
      <el-button
        v-if="auth.can('billing.plans.manage')"
        @click="draftsOpen = true"
        >{{ tr('商品草稿', 'Product drafts') }}</el-button
      >
      <el-button
        v-if="auth.can('billing.plans.manage')"
        type="primary"
        @click="editor = { series: null, withdraw: false }"
        >{{ tr('新增套餐', 'Create plan') }}</el-button
      ></FilterBar
    >
    <ResourceStatus :loading="loading" :error="error" @retry="reload" />
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ManagementList :page="page" :page-size="size"
      ><DataTable mobile-cards :label="tr('套餐目录', 'Plan catalog')">
        <thead>
          <tr>
            <th>{{ tr('商品', 'Product') }}</th>
            <th>{{ tr('当前版本', 'Current version') }}</th>
            <th>{{ tr('待生效版本', 'Scheduled version') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data?.items ?? []" :key="s.latest.sku">
            <td>
              <strong>{{ s.current?.name ?? s.latest.name }}</strong
              ><small
                >{{ s.latest.sku }} ·
                {{
                  s.latest.kind === 'membership'
                    ? tr('会员', 'Membership')
                    : tr('加购包', 'Top-up')
                }}</small
              >
            </td>
            <td :data-label="tr('当前版本', 'Current version')">
              <template v-if="s.current">
                v{{ s.current.revision }} ·
                {{
                  s.current.listed
                    ? tr('在售', 'Listed')
                    : tr('已下架', 'Delisted')
                }}
                <small
                  >¥{{ s.current.priceFen / 100 }} ·
                  {{ s.current.points.toLocaleString() }}
                  {{ tr('点', 'credits') }} /
                  {{
                    s.current.termUnit === 'year'
                      ? tr('年', 'year')
                      : tr('月', 'month')
                  }}</small
                > </template
              ><span v-else>{{
                tr('尚无生效版本', 'No effective version')
              }}</span>
            </td>
            <td :data-label="tr('待生效版本', 'Scheduled version')">
              <template v-if="s.upcoming"
                >v{{ s.upcoming.revision }} ·
                {{
                  s.upcoming.listed ? tr('上架', 'List') : tr('下架', 'Delist')
                }}
                <small
                  >¥{{ s.upcoming.priceFen / 100 }} ·
                  {{ s.upcoming.points.toLocaleString() }}
                  {{ tr('点', 'credits') }} /
                  {{
                    s.upcoming.termUnit === 'year'
                      ? tr('年', 'year')
                      : tr('月', 'month')
                  }}</small
                ><small>{{
                  billingTime(s.upcoming.effectiveAt)
                }}</small> </template
              ><span v-else>—</span>
            </td>
            <td class="actions">
              <div class="toolbar">
                <el-button link @click="history = s">{{
                  tr('版本历史', 'History')
                }}</el-button>
                <el-button
                  v-if="auth.can('billing.plans.manage') && !s.upcoming"
                  link
                  @click="editor = { series: s, withdraw: false }"
                  >{{ tr('发布新版本', 'Publish version') }}</el-button
                >
                <el-button
                  v-if="auth.can('billing.plans.manage') && s.upcoming"
                  link
                  @click="editor = { series: s, withdraw: true }"
                  >{{ tr('撤回定时发布', 'Withdraw schedule') }}</el-button
                >
              </div>
            </td>
          </tr>
          <tr v-if="!loading && !error && data?.items.length === 0">
            <td colspan="4" class="empty-cell">
              {{ tr('没有符合条件的商品', 'No matching products') }}
            </td>
          </tr>
        </tbody> </DataTable
      ><template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :page-sizes="[10, 20, 50]"
          :total="data?.total ?? 0"
          :loading="loading" /></template
    ></ManagementList>
    <CatalogEditor
      v-if="editor"
      :series="editor.series"
      :stored="editor.stored"
      :withdraw="editor.withdraw"
      @saved="complete"
      @refresh="refresh"
      @close="editor = null"
    />
    <PlanDraftDirectory
      v-if="draftsOpen"
      @close="draftsOpen = false"
      @resume="
        (stored, series) => {
          draftsOpen = false
          editor = { series, stored, withdraw: false }
        }
      "
    />
    <CatalogHistory v-if="history" :series="history" @close="history = null" />
  </section>
</template>
