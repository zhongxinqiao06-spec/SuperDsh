<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { operationsApi } from '@/api/billing/operations-api'
import { membershipApi } from '@/api/billing/membership-api'
import PageHeader from '@/components/layout/PageHeader.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import DataTable from '@/components/management/DataTable.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import {
  awaitsBooking,
  billingTime,
  changeLabel,
} from '@/utils/billing/change-labels'
import PlanChangeDialog from './components/PlanChangeDialog.vue'
import type {
  BillingAccount,
  BillingAction,
  BillingOperation,
} from '@/types/billing/operations'
import OperationDialog from './components/OperationDialog.vue'
import OperationHistory from './components/OperationHistory.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences(),
  auth = useAuthStore(),
  route = useRoute()
const router = useRouter()
const draft = reactive({ search: '', state: '', sku: '', expiringDays: '' })
const filters = ref({ ...draft })
const page = ref(1),
  size = ref(10),
  notice = ref('')
const focused = ref(
  typeof route.query.userId === 'string' ? route.query.userId : '',
)
const selected = ref<{ account: BillingAccount; action: BillingAction } | null>(
  null,
)
const historic = ref<BillingAccount | null>(null)
const change = ref<{
  account: BillingAccount
  mode: 'schedule' | 'cancel'
} | null>(null)
function showEffective() {
  notice.value = tr(
    '预约档位已生效，会员记录已刷新。',
    'The booked plan has started. Membership details have been refreshed.',
  )
  closeChange()
}
function closeChange(saved = false) {
  if (saved)
    notice.value =
      change.value?.mode === 'schedule'
        ? tr('换档预约已登记', 'Plan change scheduled')
        : tr('已撤销换档预约', 'Plan change cancelled')
  change.value = null
  void reload()
}
const catalog = useResource(membershipApi.catalog)
const { data, loading, error, reload } = useResource((signal) =>
  operationsApi.accounts(
    {
      page: page.value,
      pageSize: size.value,
      userId: focused.value || undefined,
      search: filters.value.search || undefined,
      state: filters.value.state || undefined,
      sku: filters.value.sku || undefined,
      expiringDays: filters.value.expiringDays || undefined,
    },
    signal,
  ),
)
watch([page, size, filters, focused], () => {
  data.value = null
  void reload()
})
watch(
  () => route.query.userId,
  (value) => {
    focused.value = typeof value === 'string' ? value : ''
    page.value = 1
  },
)
function search() {
  page.value = 1
  if (focused.value) {
    const query = { ...route.query }
    delete query.userId
    focused.value = ''
    void router.replace({ query })
  }
  filters.value = { ...draft }
}
function saved(r: BillingOperation) {
  selected.value = null
  notice.value = tr('办理成功，单号 ', 'Confirmed. Operation ') + r.id
  void reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('会员记录与办理', 'Membership operations')" />
    <FilterBar class="toolbar billing-directory-filter" @submit="search">
      <el-input
        v-model="draft.search"
        :aria-label="tr('搜索账号', 'Search accounts')"
        :placeholder="tr('搜索用户名或名称', 'Username or display name')"
        clearable
      />
      <select
        v-model="draft.state"
        class="native-control"
        :aria-label="tr('会员状态', 'Membership state')"
      >
        <option value="">{{ tr('全部状态', 'All statuses') }}</option>
        <option value="active">
          {{ tr('有效会员', 'Active memberships') }}
        </option>
        <option value="expired">{{ tr('已到期', 'Expired') }}</option>
        <option value="none">{{ tr('未开通', 'Never enrolled') }}</option>
      </select>
      <select
        v-model="draft.sku"
        class="native-control"
        :aria-label="tr('套餐', 'Plan')"
      >
        <option value="">{{ tr('全部套餐', 'All plans') }}</option>
        <option
          v-for="plan in catalog.data.value?.items.filter(
            (p) => p.kind === 'membership',
          ) ?? []"
          :key="plan.sku"
          :value="plan.sku"
        >
          {{ plan.name }}
        </option>
      </select>
      <select
        v-model="draft.expiringDays"
        class="native-control"
        :aria-label="tr('到期范围', 'Expiry range')"
      >
        <option value="">{{ tr('全部到期日', 'All expiry dates') }}</option>
        <option value="7">{{ tr('7 天内到期', 'Within 7 days') }}</option>
        <option value="30">
          {{ tr('30 天内到期', 'Within 30 days') }}
        </option></select
      ><el-button native-type="submit">{{
        tr('搜索', 'Search')
      }}</el-button></FilterBar
    >
    <ResourceStatus
      :loading="loading"
      :error="error"
      @retry="reload"
    /><ResourceStatus
      v-if="catalog.error.value"
      :error="catalog.error.value"
      @retry="catalog.reload"
    />
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ManagementList :page="page" :page-size="size"
      ><DataTable mobile-cards :label="tr('会员记录', 'Membership records')"
        ><thead>
          <tr>
            <th>{{ tr('账号', 'Account') }}</th>
            <th>{{ tr('会员及到期日', 'Membership and expiry') }}</th>
            <th>{{ tr('可用点', 'Available credits') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in data?.items ?? []" :key="a.userId">
            <td>
              <strong>{{ a.displayName || a.username }}</strong
              ><small
                >{{ a.username
                }}<template v-if="a.disabled">
                  · {{ tr('已禁用', 'Disabled') }}</template
                ></small
              >
            </td>
            <td :data-label="tr('会员', 'Membership')">
              {{ a.planName ?? tr('未开通', 'Not enrolled')
              }}<small v-if="a.endsAt"
                >{{
                  a.state === 'expired'
                    ? tr('已到期', 'Expired')
                    : tr('已购至', 'Booked through')
                }}
                · {{ billingTime(a.endsAt) }}</small
              >
              <small v-if="a.lastBookedSku !== a.planSku && a.lastBookedName"
                >{{ tr('已购末期', 'Last booked plan') }} ·
                {{ a.lastBookedName }}</small
              >
              <small v-if="a.planChange"
                >{{ changeLabel(a.planChange.state, tr) }} ·
                {{ a.planChange.toPlanName }} ·
                {{ billingTime(a.planChange.effectiveAt) }}</small
              >
            </td>
            <td :data-label="tr('可用点', 'Available credits')">
              {{ a.availablePoints.toLocaleString() }}
            </td>
            <td class="actions">
              <div class="toolbar">
                <el-button link @click="historic = a">{{
                  tr('办理记录', 'History')
                }}</el-button>
                <el-button
                  v-if="!a.disabled && auth.can('billing.subscriptions.manage')"
                  link
                  @click="
                    selected = {
                      account: a,
                      action: a.state === 'active' ? 'renew' : 'open',
                    }
                  "
                  >{{
                    a.state === 'active'
                      ? tr('续期', 'Renew')
                      : tr('开通', 'Activate')
                  }}</el-button
                >
                <el-button
                  v-if="
                    a.state === 'active' &&
                    !a.disabled &&
                    !awaitsBooking(a.planChange) &&
                    auth.can('billing.subscriptions.manage')
                  "
                  link
                  :disabled="catalog.loading.value || !!catalog.error.value"
                  @click="change = { account: a, mode: 'schedule' }"
                  >{{ tr('预约换档', 'Schedule change') }}</el-button
                >
                <el-button
                  v-if="
                    a.planChange && auth.can('billing.subscriptions.manage')
                  "
                  link
                  @click="change = { account: a, mode: 'cancel' }"
                  >{{ tr('撤销预约', 'Cancel reservation') }}</el-button
                >
                <el-button
                  v-if="!a.disabled && auth.can('billing.adjustments.create')"
                  link
                  @click="selected = { account: a, action: 'gift' }"
                  >{{ tr('加额度', 'Add credits') }}</el-button
                >
              </div>
            </td>
          </tr>
          <tr v-if="!loading && !error && data?.items.length === 0">
            <td colspan="4" class="empty-cell">
              {{ tr('没有符合条件的账号', 'No matching accounts') }}
            </td>
          </tr>
        </tbody></DataTable
      >
      <template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :page-sizes="[10, 20, 50]"
          :total="data?.total ?? 0"
          :loading="loading" /></template
    ></ManagementList>
    <OperationDialog
      v-if="selected"
      :key="selected.account.userId"
      :account="selected.account"
      :initial="selected.action"
      @saved="saved"
      @close="selected = null"
    />
    <PlanChangeDialog
      v-if="change"
      :mode="change.mode"
      :account="change.account"
      :plans="catalog.data.value?.items ?? []"
      @saved="closeChange(true)"
      @effective="showEffective"
      @refresh="closeChange()"
      @close="change = null"
    />
    <OperationHistory
      v-if="historic"
      :account="historic"
      @close="historic = null"
    />
  </section>
</template>
