<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/store/modules/auth-store'
import AccountGrantActions from '@/views/billing/components/AccountGrantActions.vue'
import OperationDialog from '@/views/billing/components/OperationDialog.vue'
import type {
  BillingAccount,
  BillingAction,
  BillingOperation,
} from '@/types/billing/operations'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useProductMembers } from '@/composables/products/use-product-members'
import { usePreferences } from '@/store/modules/preferences'
import { roleLabel } from '@/utils/access/role-labels'
const vm = useProductMembers()
const auth = useAuthStore()
const selected = ref<{ account: BillingAccount; action: BillingAction } | null>(
  null,
)
const notice = ref('')
function operate(account: BillingAccount, action: BillingAction) {
  selected.value = { account, action }
}
function saved(result: BillingOperation) {
  selected.value = null
  notice.value = tr('办理成功，单号 ', 'Confirmed. Operation ') + result.id
  void vm.resource.reload()
}
const { tr } = usePreferences()
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('产品成员', 'Product members')" />
    <FilterBar @submit="vm.filter"
      ><el-input
        v-model="vm.query.value"
        aria-label="搜索产品成员"
        placeholder="搜索用户名或显示名称"
        clearable
        maxlength="120"
      /><el-button native-type="submit">搜索</el-button
      ><el-button type="primary" @click="vm.add">添加成员</el-button></FilterBar
    >
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    />
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable mobile-cards label="产品成员">
        <thead>
          <tr>
            <th>账号</th>
            <th>显示名称</th>
            <th>本产品角色</th>
            <th v-if="auth.can('billing.read')">会员与额度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="member in vm.resource.data.value?.items"
            :key="member.userId"
          >
            <td>{{ member.username }}</td>
            <td data-label="显示名称">{{ member.displayName || '—' }}</td>
            <td data-label="本产品角色">
              {{ member.roleIds.map((id) => roleLabel(id, tr)).join('、') }}
            </td>
            <td v-if="auth.can('billing.read')" data-label="会员与额度">
              <template v-if="member.billing">
                {{ member.billing.planName ?? tr('未开通', 'Not enrolled') }}
                <small
                  >{{ tr('可用', 'Available') }}
                  {{
                    member.billing.unlimited
                      ? tr('无限额度', 'Unlimited')
                      : member.billing.availablePoints.toLocaleString()
                  }}</small
                > </template
              ><span v-else>—</span>
            </td>
            <td data-label="操作">
              <div class="toolbar">
                <AccountGrantActions
                  v-if="member.billing"
                  :account="member.billing"
                  @operate="operate"
                />
                <el-button
                  v-if="member.removable"
                  link
                  type="danger"
                  @click="vm.remove(member)"
                  >移除成员</el-button
                ><span v-else class="muted">由角色授权</span>
              </div>
            </td>
          </tr>
          <tr
            v-if="
              vm.resource.data.value && !vm.resource.data.value.items.length
            "
          >
            <td class="empty-cell" :colspan="auth.can('billing.read') ? 5 : 4">
              没有匹配的产品成员
            </td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination
        ><ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.resource.data.value?.total ?? 0"
      /></template>
    </ManagementList>
    <OperationDialog
      v-if="selected"
      :key="selected.account.userId"
      :account="selected.account"
      :initial="selected.action"
      @close="selected = null"
      @saved="saved"
    />
    <ManagementDialog
      v-model="vm.adding.value"
      title="添加产品成员"
      submit-text="添加"
      :submit-disabled="!vm.identifier.value.trim()"
      :error="vm.mutation.error.value"
      :busy="vm.mutation.busy.value"
      @submit="vm.grant"
    >
      <label class="field"
        >现有账号的用户名或邮箱<el-input
          v-model="vm.identifier.value"
          maxlength="254"
          autofocus
      /></label>
    </ManagementDialog>
    <ManagementDialog
      :model-value="!!vm.removing.value"
      title="移除产品成员"
      submit-text="确认移除"
      :error="vm.mutation.error.value"
      :busy="vm.mutation.busy.value"
      @update:model-value="vm.removing.value = null"
      @submit="vm.revoke"
    >
      <p>
        确认移除「{{
          vm.removing.value?.displayName || vm.removing.value?.username
        }}」的本产品使用资格？账号及作品将保留。
      </p>
    </ManagementDialog>
  </section>
</template>
