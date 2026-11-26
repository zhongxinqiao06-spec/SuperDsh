<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useUsers } from '@/composables/access/use-users'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import OperationDialog from '@/views/billing/components/OperationDialog.vue'
import type {
  BillingAccount,
  BillingAction,
  BillingOperation,
} from '@/types/billing/operations'
import { dateTimeLabel } from '@/utils/date-time'
import '@/assets/styles/billing.css'
/** 用户页只组装列表、表单和确认；请求与业务状态由composable提供。 */
const vm = useUsers()
const target = ref<BillingAccount | null>(null)
const action = ref<BillingAction>('gift')
function operate(account: BillingAccount, kind: BillingAction) {
  action.value = kind
  target.value = account
}
const route = useRoute()
function saved(result: BillingOperation) {
  target.value = null
  vm.notice.value = tr('办理成功，单号 ', 'Confirmed. Operation ') + result.id
  void vm.resource.reload()
}
const { tr } = usePreferences()
</script>

<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('用户管理', 'Users')" />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        :placeholder="tr('搜索用户名、邮箱或名称', 'Search users')"
        :aria-label="tr('搜索用户', 'Search users')"
        clearable
      /><el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button>
      <el-button
        v-if="vm.editable.value"
        type="primary"
        @click="vm.edit('new')"
        >{{ tr('创建用户', 'Create user') }}</el-button
      >
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    />
    <el-alert
      v-if="vm.notice.value"
      :title="vm.notice.value"
      type="info"
      :closable="true"
      @close="vm.notice.value = ''"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable mobile-cards label="数据列表" table-class="users-table">
        <thead>
          <tr>
            <th>{{ tr('用户', 'User') }}</th>
            <th>{{ tr('角色', 'Roles') }}</th>
            <th v-if="vm.auth.can('billing.read')">
              {{ tr('会员与额度', 'Membership and credits') }}
            </th>
            <th>{{ tr('状态', 'Status') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="user in vm.resource.data.value?.users ?? []"
            :key="user.userId"
          >
            <td>
              <strong>{{ user.displayName }}</strong
              ><small
                >{{ user.username
                }}<template v-if="user.email">
                  · {{ user.email }}</template
                ></small
              >
            </td>
            <td :data-label="tr('角色', 'Roles')">
              {{
                (user.roles ?? [user.role])
                  .map(
                    (id) =>
                      vm.roleResource.data.value?.roles.find(
                        (role) => role.id === id,
                      )?.name ?? id,
                  )
                  .join(', ')
              }}
            </td>
            <td
              v-if="vm.auth.can('billing.read')"
              :data-label="tr('会员与额度', 'Membership and credits')"
            >
              <template v-if="user.billing">
                <router-link
                  :to="{
                    path: '/billing/subscriptions',
                    query: {
                      product: route.query.product,
                      userId: user.userId,
                    },
                  }"
                  >{{
                    user.billing.planName ?? tr('未开通', 'Not enrolled')
                  }}</router-link
                >
                <small v-if="user.billing.endsAt"
                  >{{ tr('到期', 'Expires') }} ·
                  {{ dateTimeLabel(user.billing.endsAt) }}</small
                >
                <small
                  >{{ tr('可用', 'Available') }}
                  {{ user.billing.availablePoints }}</small
                >
                <el-button
                  v-if="
                    !user.disabled && vm.auth.can('billing.adjustments.create')
                  "
                  link
                  @click="operate(user.billing, 'gift')"
                  >{{ tr('加额度', 'Add credits') }}</el-button
                >
                <el-button
                  v-if="
                    !user.disabled && vm.auth.can('billing.adjustments.create')
                  "
                  link
                  @click="operate(user.billing, 'card')"
                  >{{ tr('发额度卡', 'Issue card') }}</el-button
                >
                <el-button
                  v-if="
                    !user.disabled &&
                    vm.auth.can('billing.subscriptions.manage')
                  "
                  link
                  @click="
                    operate(
                      user.billing,
                      user.billing.state === 'active' ? 'renew' : 'open',
                    )
                  "
                >
                  {{
                    user.billing.state === 'active'
                      ? tr('续期', 'Renew')
                      : tr('开通', 'Activate')
                  }}</el-button
                > </template
              ><span v-else>—</span>
            </td>
            <td :data-label="tr('状态', 'Status')">
              <span>
                {{
                  user.deletedAt
                    ? tr('已删除', 'Deleted')
                    : user.disabled
                      ? tr('已禁用', 'Disabled')
                      : tr('已激活', 'Active')
                }}
              </span>
              <small v-if="user.resetRequired">{{
                tr('需要本人修改密码', 'Password change required')
              }}</small>
            </td>
            <td class="actions">
              <RowActions
                v-if="vm.editable.value"
                :busy="vm.mutation.busy.value"
              >
                <el-button
                  v-if="vm.editable.value && !user.deletedAt"
                  link
                  @click="vm.edit(user)"
                >
                  {{ tr('编辑', 'Edit') }}
                </el-button>
                <el-button
                  v-if="!user.deletedAt"
                  link
                  :disabled="user.userId === vm.auth.session?.userId"
                  @click="
                    vm.requestConfirmation(
                      user,
                      user.disabled ? 'activate' : 'disable',
                    )
                  "
                >
                  {{
                    user.disabled ? tr('启用', 'Enable') : tr('禁用', 'Disable')
                  }}
                </el-button>
                <el-button
                  v-if="!user.deletedAt"
                  link
                  @click="vm.requestConfirmation(user, 'reset')"
                  >{{ tr('本人重置密码', 'Reset own password') }}</el-button
                >
                <el-button
                  link
                  :class="{ 'danger-action': !user.deletedAt }"
                  :disabled="user.userId === vm.auth.session?.userId"
                  @click="
                    vm.requestConfirmation(
                      user,
                      user.deletedAt ? 'restore' : 'delete',
                    )
                  "
                >
                  {{
                    user.deletedAt
                      ? tr('恢复', 'Restore')
                      : tr('删除', 'Delete')
                  }}
                </el-button>
              </RowActions>
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              vm.resource.data.value?.users.length === 0
            "
          >
            <td
              :colspan="vm.auth.can('billing.read') ? 5 : 4"
              class="empty-cell"
            >
              {{ tr('没有符合条件的用户', 'No matching users') }}
            </td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :page-sizes="[10, 20, 50]"
          :total="vm.resource.data.value?.total ?? 0"
        />
      </template>
    </ManagementList>
    <OperationDialog
      v-if="target"
      :account="target"
      :initial="action"
      @saved="saved"
      @close="target = null"
    />

    <ManagementDialog
      :model-value="vm.editing.value !== null"
      :title="
        vm.editing.value === 'new'
          ? tr('创建用户', 'Create user')
          : tr('编辑用户', 'Edit user')
      "
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
    >
      <div class="user-editor-grid">
        <label class="field"
          >{{ tr('用户名', 'Username')
          }}<el-input
            v-model="vm.draft.username"
            :disabled="vm.editing.value !== 'new'"
            maxlength="100"
            autocomplete="off"
        /></label>
        <label class="field"
          >{{ tr('显示名称', 'Display name')
          }}<el-input v-model="vm.draft.displayName" maxlength="100"
        /></label>
        <label v-if="vm.editing.value === 'new'" class="field"
          >{{ tr('邮箱（可选）', 'Email (optional)')
          }}<el-input v-model="vm.draft.email" type="email" maxlength="254"
        /></label>
        <label v-if="vm.editing.value === 'new'" class="field"
          >{{ tr('初始密码', 'Initial password')
          }}<el-input
            v-model="vm.draft.password"
            type="password"
            show-password
            autocomplete="new-password"
        /></label>
        <label
          v-if="vm.auth.can('roles.manage')"
          class="field user-editor-roles"
          >{{ tr('角色（权限取并集）', 'Roles (combined permissions)')
          }}<el-checkbox-group
            v-model="vm.draft.roles"
            :disabled="
              vm.editing.value !== 'new' &&
              vm.editing.value?.userId === vm.auth.session?.userId
            "
            ><el-checkbox
              v-for="role in vm.roleResource.data.value?.roles ?? []"
              :key="role.id"
              :value="role.id"
              >{{ role.name }}</el-checkbox
            ></el-checkbox-group
          ></label
        >
      </div>
      <ResourceStatus
        :error="vm.roleResource.error.value"
        @retry="vm.roleResource.reload"
      />
    </ManagementDialog>
    <el-dialog
      :model-value="vm.confirmation.value !== null"
      :title="tr('确认操作', 'Confirm action')"
      width="min(440px,94vw)"
      :close-on-click-modal="false"
      @update:model-value="vm.confirmation.value = null"
    >
      <div class="stack">
        <p>
          {{
            tr(
              '确认对以下账号执行此操作？',
              'Confirm this action on the account?',
            )
          }}
          <strong>{{ vm.confirmation.value?.user.displayName }}</strong>
        </p>
        <p v-if="vm.confirmation.value?.action === 'delete'">
          {{
            tr(
              '账号将停用并撤销登录；数据保留，可以恢复。',
              'The account is deactivated and sign-ins revoked. Data is retained and can be restored.',
            )
          }}
        </p>
        <p v-else-if="vm.confirmation.value?.action === 'restore'">
          {{
            tr(
              '恢复账号不会恢复已经撤销的登录。',
              'Restoring an account does not restore revoked sign-ins.',
            )
          }}
        </p>
        <p v-else-if="vm.confirmation.value?.action === 'reset'">
          {{
            tr(
              '请用户在登录页用自己的恢复码重置密码。管理员无法设置他人的新密码。',
              'The user must reset their password with their own recovery code on the sign-in page. Administrators cannot set another account’s password.',
            )
          }}
        </p>
        <el-alert
          v-if="vm.mutation.error.value"
          :title="vm.mutation.error.value"
          type="error"
          :closable="false"
        />
      </div>
      <template #footer>
        <el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.confirmation.value = null"
        >
          {{ tr('取消', 'Cancel') }} </el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.confirm"
        >
          {{ tr('确认', 'Confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>
