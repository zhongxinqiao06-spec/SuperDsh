<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore } from '@/store/modules/auth-store'
import AccountGrantActions from '@/views/billing/components/AccountGrantActions.vue'
import OperationDialog from '@/views/billing/components/OperationDialog.vue'
import type { RowAction } from '@/types/common/management'
import type { ProductMember } from '@/types/products/management'
import type {
  BillingAccount,
  BillingAction,
  BillingOperation,
} from '@/types/billing/operations'
import MemberActionMenu from '@/components/management/MemberActionMenu.vue'
import { useCurrentProduct } from '@/composables/console/use-current-product'
import { useRoute, useRouter } from 'vue-router'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useProductMembers } from '@/composables/products/use-product-members'
import { usePreferences } from '@/store/modules/preferences'
import { roleLabel } from '@/utils/access/role-labels'
const route = useRoute(),
  router = useRouter()
const product = useCurrentProduct()
const removeLabel = computed(() =>
  product.value === 'entertainment'
    ? tr('移出娱乐产品', 'Remove from Studio')
    : tr('移出办公产品', 'Remove from Office'),
)
function memberOptions(member: ProductMember): RowAction[] {
  const items: RowAction[] = []
  if (auth.can('billing.read'))
    items.push({
      key: 'history',
      label: tr('查看办理记录', 'View billing records'),
    })
  if (member.removable)
    items.push({ key: 'remove', label: removeLabel.value, danger: true })
  return items
}
function selectOption(member: ProductMember, key: string) {
  if (key === 'remove') vm.remove(member)
  if (key === 'history')
    void router.push({
      path: '/billing/subscriptions',
      query: { product: product.value, userId: member.userId },
    })
}
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
  <section class="page paged-page management-page member-directory">
    <FilterBar @submit="vm.filter"
      ><el-input
        v-model="vm.query.value"
        aria-label="搜索产品成员"
        placeholder="搜索用户名或显示名称"
        clearable
        maxlength="120"
      /><el-button native-type="submit">搜索</el-button
      ><el-button type="primary" class="member-create" @click="vm.add"
        >添加已有账号</el-button
      ></FilterBar
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
            <th>本产品角色</th>
            <th v-if="auth.can('billing.read')">会员与额度</th>
            <th>账号状态</th>
            <th class="member-action-cell">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="member in vm.resource.data.value?.items"
            :key="member.userId"
          >
            <td>
              <strong>{{ member.displayName || member.username }}</strong
              ><small
                v-if="
                  member.displayName && member.displayName !== member.username
                "
                >{{ member.username }}</small
              >
            </td>
            <td data-label="本产品角色">
              {{ member.roleIds.map((id) => roleLabel(id, tr)).join('、') }}
            </td>
            <td v-if="auth.can('billing.read')" data-label="会员与额度">
              <template v-if="member.billing">
                <router-link
                  :to="{
                    path: '/billing/subscriptions',
                    query: {
                      product: route.query.product,
                      userId: member.userId,
                    },
                  }"
                  >{{
                    member.billing.planName ?? tr('未开通会员', 'Not enrolled')
                  }}</router-link
                >
                <small>{{
                  member.billing.unlimited
                    ? tr('无限额度', 'Unlimited')
                    : tr('可用 ', 'Available ') +
                      member.billing.availablePoints.toLocaleString() +
                      tr(' 点', ' credits')
                }}</small> </template
              ><span v-else>—</span>
            </td>
            <td data-label="账号状态">
              <span
                class="member-status"
                :class="{ 'is-inactive': member.disabled }"
              >
                {{
                  member.disabled
                    ? tr('已禁用', 'Disabled')
                    : tr('已激活', 'Active')
                }}
              </span>
            </td>
            <td class="member-action-cell" data-label="操作">
              <div class="member-row-actions">
                <AccountGrantActions
                  v-if="member.billing"
                  :account="member.billing"
                  @operate="operate"
                />
                <MemberActionMenu
                  :owner="member.displayName || member.username"
                  :label="tr('更多', 'More')"
                  :actions="memberOptions(member)"
                  @action="selectOption(member, $event)"
                />
                <small v-if="!member.removable && !auth.can('billing.read')">{{
                  tr('由角色授权', 'Granted by role')
                }}</small>
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
      :title="removeLabel"
      :submit-text="removeLabel"
      :error="vm.mutation.error.value"
      :busy="vm.mutation.busy.value"
      @update:model-value="vm.removing.value = null"
      @submit="vm.revoke"
    >
      <p>
        确认移除「{{
          vm.removing.value?.displayName || vm.removing.value?.username
        }}」在{{
          product === 'entertainment' ? '星桥娱乐' : '星桥办公'
        }}的使用资格？账号、作品及其他产品的使用资格将保留。
      </p>
    </ManagementDialog>
  </section>
</template>
