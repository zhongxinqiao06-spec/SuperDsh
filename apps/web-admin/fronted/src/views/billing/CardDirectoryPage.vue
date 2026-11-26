<script setup lang="ts">
import { ref, watch } from 'vue'
import { operationsApi } from '@/api/billing/operations-api'
import DataTable from '@/components/management/DataTable.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import type {
  BillingAccount,
  BillingOperation,
} from '@/types/billing/operations'
import CreditCards from './components/CreditCards.vue'
import OperationDialog from './components/OperationDialog.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const auth = useAuthStore()
const query = ref(''),
  search = ref(''),
  page = ref(1),
  size = ref(10)
const issuing = ref<BillingAccount | null>(null),
  viewing = ref<BillingAccount | null>(null)
const notice = ref('')
const { data, loading, error, reload } = useResource((signal) =>
  operationsApi.accounts(
    { search: search.value, page: page.value, pageSize: size.value },
    signal,
  ),
)
watch(
  size,
  () => {
    page.value = 1
  },
  { flush: 'sync' },
)
watch([search, page, size], () => {
  data.value = null
  void reload()
})
function filter() {
  const value = query.value.trim()
  if (search.value === value && page.value === 1) void reload()
  search.value = value
  page.value = 1
}
function saved(r: BillingOperation) {
  issuing.value = null
  notice.value = tr('额度卡已发放，单号 ', 'Card issued. Operation ') + r.id
  void reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('额度卡管理', 'Credit card management')" />
    <FilterBar @submit="filter"
      ><el-input
        v-model="query"
        maxlength="100"
        clearable
        :aria-label="tr('搜索账号', 'Search accounts')"
        :placeholder="tr('搜索用户名或显示名称', 'Username or display name')"
      />
      <el-button native-type="submit">{{
        tr('搜索', 'Search')
      }}</el-button></FilterBar
    >
    <ResourceStatus :loading="loading" :error="error" @retry="reload" />
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ManagementList :page="page" :page-size="size">
      <DataTable
        mobile-cards
        :label="tr('额度卡管理', 'Credit card management')"
      >
        <thead>
          <tr>
            <th>{{ tr('账号', 'Account') }}</th>
            <th>{{ tr('可用创作点', 'Available credits') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in data?.items" :key="account.userId">
            <td>
              <strong>{{ account.displayName || account.username }}</strong
              ><small
                >{{ account.username
                }}<template v-if="account.disabled">
                  · {{ tr('已禁用', 'Disabled') }}</template
                ></small
              >
            </td>
            <td :data-label="tr('可用创作点', 'Available credits')">
              {{
                account.unlimited
                  ? tr('无限额度', 'Unlimited')
                  : account.availablePoints.toLocaleString()
              }}
            </td>
            <td :data-label="tr('操作', 'Actions')">
              <div class="toolbar">
                <el-button
                  v-if="
                    auth.can('billing.adjustments.create') && !account.disabled
                  "
                  link
                  @click="issuing = account"
                  >{{ tr('发额度卡', 'Issue card') }}</el-button
                >
                <el-button link @click="viewing = account">{{
                  tr('查看额度卡', 'View cards')
                }}</el-button>
              </div>
            </td>
          </tr>
          <tr v-if="!loading && !error && data?.total === 0">
            <td colspan="3" class="empty-cell">
              {{ tr('没有符合条件的账号', 'No matching accounts') }}
            </td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :loading="loading"
          :total="data?.total ?? 0"
      /></template>
    </ManagementList>
    <OperationDialog
      v-if="issuing"
      :key="issuing.userId"
      :account="issuing"
      initial="card"
      card-only
      @close="issuing = null"
      @saved="saved"
    />
    <ManagementDialog
      v-if="viewing"
      :model-value="true"
      readonly
      :title="tr('查看额度卡', 'View cards') + ' · ' + viewing.username"
      @update:model-value="!$event && (viewing = null)"
    >
      <CreditCards :key="viewing.userId" :owner="viewing.userId" />
    </ManagementDialog>
  </section>
</template>
