<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { usePreferences } from '@/store/modules/preferences'
import { useSecurity } from '@/composables/account/use-security'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
/** 账号安全页由真实会话数据驱动，撤销与改密需显式提交。 */
const { tr } = usePreferences()
const {
  resource,
  mutation,
  changing,
  password,
  confirm,
  selected,
  closePassword,
  changePassword,
  revoke,
  openPassword,
  requestRevoke,
  codes,
  creatingCodes,
  loggingOut,
  recoveryCodes,
  logoutAll,
  page,
  pageSize,
} = useSecurity()
</script>

<template>
  <section class="page settings-page">
    <PageHeader :title="tr('账号安全与登录记录', 'Security and sign-ins')" />
    <SettingsCard
      :title="tr('密码', 'Password')"
      :description="
        tr('重置用于登录的密码。', 'Reset the password used to sign in.')
      "
      ><template #action
        ><el-button @click="openPassword">{{
          tr('重置密码', 'Reset password')
        }}</el-button></template
      ></SettingsCard
    >
    <ResourceStatus
      :loading="resource.loading.value"
      :error="resource.error.value"
      @retry="resource.reload"
    />
    <el-alert
      v-if="codes.length"
      :title="
        tr(
          '请离线保存恢复码，关闭页面后无法再次查看。每个码仅可使用一次。',
          'Save these recovery codes offline. They are shown only once and each can be used once.',
        )
      "
      type="warning"
      :closable="false"
    />
    <div v-if="codes.length" class="panel stack">
      <code v-for="code in codes" :key="code">{{ code }}</code
      ><el-button @click="codes = []">{{
        tr('我已保存，隐藏恢复码', 'I saved these codes; hide them')
      }}</el-button>
    </div>
    <ManagementDialog
      v-model="creatingCodes"
      :title="tr('重新生成恢复码', 'Replace recovery codes')"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      @submit="recoveryCodes"
      ><p>
        {{
          tr(
            '生成后所有旧恢复码立即失效，是否继续？',
            'All existing recovery codes will stop working. Continue?',
          )
        }}
      </p></ManagementDialog
    >
    <ManagementDialog
      v-model="loggingOut"
      :title="tr('退出全部登录', 'Sign out everywhere')"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      @submit="logoutAll"
      ><p>
        {{
          tr(
            '包括当前浏览器在内的所有登录都将撤销。',
            'This revokes every session, including this browser.',
          )
        }}
      </p></ManagementDialog
    >
    <SettingsCard
      :title="tr('登录会话与账号恢复', 'Sign-in sessions and account recovery')"
      ><template #action
        ><el-button @click="resource.reload">{{
          tr('刷新', 'Refresh')
        }}</el-button></template
      >
      <div class="security-signins">
        <p v-if="resource.data.value?.sessions.length === 0" class="muted">
          {{ tr('暂无登录会话', 'No sign-in sessions') }}
        </p>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>{{ tr('客户端', 'Client') }}</th>
              <th>{{ tr('登录时间', 'Signed in') }}</th>
              <th>{{ tr('最近活跃', 'Last active') }}</th>
              <th>{{ tr('操作', 'Actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="session in resource.data.value?.sessions ?? []"
              :key="session.id"
            >
              <td>
                {{ session.clientName }}
                <el-tag v-if="session.current">
                  {{ tr('当前', 'Current') }}
                </el-tag>
              </td>
              <td>{{ session.createdAt }}</td>
              <td>{{ session.lastSeenAt ?? session.createdAt }}</td>
              <td>
                <RowActions :busy="mutation.busy.value">
                  <el-button
                    v-if="!session.current"
                    link
                    type="danger"
                    @click="requestRevoke(session)"
                  >
                    {{ tr('撤销', 'Revoke') }}
                  </el-button>
                </RowActions>
              </td>
            </tr>
          </tbody>
        </table>
        <ManagementPagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="resource.data.value?.total ?? 0"
        />
        <div class="toolbar">
          <el-button type="danger" plain @click="loggingOut = true">{{
            tr('退出全部登录会话', 'Sign out everywhere')
          }}</el-button
          ><el-button @click="creatingCodes = true">{{
            tr('生成恢复码', 'Generate recovery codes')
          }}</el-button>
        </div>
      </div>
    </SettingsCard>
    <ManagementDialog
      :model-value="changing"
      :title="tr('修改密码', 'Change password')"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      @update:model-value="closePassword"
      @submit="changePassword"
    >
      <label class="field"
        >{{ tr('新密码', 'New password')
        }}<el-input
          v-model="password"
          type="password"
          show-password
          autocomplete="new-password" /></label
      ><label class="field"
        >{{ tr('确认密码', 'Confirm password')
        }}<el-input
          v-model="confirm"
          type="password"
          show-password
          autocomplete="new-password"
      /></label>
    </ManagementDialog>
    <el-dialog
      :model-value="selected !== null"
      :title="tr('撤销登录', 'Revoke sign-in')"
      width="min(440px,94vw)"
      @update:model-value="selected = null"
    >
      <p>
        {{ tr('确认撤销此客户端的登录？', 'Revoke this client session?') }}
        {{ selected?.clientName }}
      </p>
      <el-alert
        v-if="mutation.error.value"
        :title="mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer>
        <el-button @click="selected = null">
          {{ tr('取消', 'Cancel') }} </el-button
        ><el-button
          type="danger"
          :loading="mutation.busy.value"
          @click="revoke"
        >
          {{ tr('确认撤销', 'Revoke') }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>
