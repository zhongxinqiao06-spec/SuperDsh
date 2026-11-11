<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useMobileConnections } from '@/composables/mobile-connections/use-mobile-connections'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
const vm = useMobileConnections(),
  preferences = usePreferences(),
  { tr } = preferences
</script>
<template>
  <section class="page paged-page settings-page">
    <PageHeader :title="tr('手机登录会话', 'Mobile sign-ins')" />
    <div class="toolbar toolbar-panel">
      <el-button @click="vm.resource.reload">{{
        tr('刷新', 'Refresh')
      }}</el-button
      ><el-button
        type="primary"
        :loading="vm.mutation.busy.value"
        @click="vm.generate"
        >{{
          tr('添加另一部手机 / 扫码登录', 'Add another phone / QR sign-in')
        }}</el-button
      >

      <el-button
        text
        @click="preferences.mobileSidebar = !preferences.mobileSidebar"
        >{{
          preferences.mobileSidebar
            ? tr('在侧边栏隐藏', 'Hide from sidebar')
            : tr('在侧边栏显示', 'Show in sidebar')
        }}</el-button
      >
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value || vm.mutation.error.value"
      @retry="vm.resource.reload"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <SettingsCard
        :title="tr('当前账号的手机登录', 'Mobile sign-ins for this account')"
        :description="
          tr(
            '每条记录代表一次有效登录，同一手机可能有多条记录。最近使用时间不代表实时在线。',
            'Each row represents an active sign-in. Recent activity does not imply a live connection.',
          )
        "
      >
        <div class="security-signins">
          <template
            v-if="!vm.sessions.value.length && !vm.resource.loading.value"
            ><p>
              {{ tr('暂无有效的手机登录会话', 'No active mobile sign-ins') }}
            </p>
            <p class="muted">
              {{
                tr(
                  '在手机 App 中使用当前账号和相同服务地址登录，再刷新此页。也可以使用上方的可选扫码登录入口。',
                  'Sign in on your phone with this account and service address, then refresh. You may also use the optional QR sign-in above.',
                )
              }}
            </p></template
          ><el-table v-else :data="vm.pageRows.value"
            ><el-table-column
              prop="clientName"
              :label="tr('客户端', 'Client')"
            /><el-table-column
              prop="createdAt"
              :label="tr('登录时间', 'Signed in')"
            /><el-table-column
              prop="expiresAt"
              :label="tr('到期时间', 'Expires')"
            /><el-table-column :label="tr('操作', 'Actions')"
              ><template #default="{ row }"
                ><RowActions :busy="vm.mutation.busy.value">
                  <el-button
                    link
                    type="danger"
                    @click="vm.selected.value = row"
                    >{{ tr('撤销登录', 'Revoke sign-in') }}</el-button
                  >
                </RowActions></template
              ></el-table-column
            ></el-table
          >
        </div>
      </SettingsCard>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :page-sizes="[10, 20, 50]"
          :total="vm.sessions.value.length"
        />
      </template>
    </ManagementList>
    <el-dialog
      :model-value="vm.opened.value"
      :title="tr('扫码连接手机', 'Connect your phone')"
      width="min(480px,94vw)"
      @update:model-value="vm.close"
      ><div class="stack">
        <img
          v-if="
            vm.image.value &&
            !['consumed', 'expired', 'rejected'].includes(
              vm.status.value?.status ?? '',
            )
          "
          :src="vm.image.value"
          width="280"
          height="280"
          :alt="tr('手机登录二维码', 'Mobile login QR code')"
        />
        <p>
          {{
            tr(
              '二维码有效期两分钟。只确认你本人手机发起的请求。',
              'Code expires in two minutes. Only approve requests from your own phone.',
            )
          }}
        </p>
        <p>{{ vm.status.value?.deviceName }}</p>
        <el-alert
          v-if="vm.status.value?.status === 'pending_web_confirm'"
          :title="
            tr(
              '手机请求连接，请核对设备后确认。',
              'Your phone requested access. Verify the device and confirm.',
            )
          "
          type="warning"
          :closable="false"
        /><el-alert
          v-else-if="vm.status.value?.status === 'consumed'"
          :title="tr('手机已登录', 'Phone signed in')"
          type="success"
          :closable="false"
        /><el-alert
          v-else-if="
            ['expired', 'rejected'].includes(vm.status.value?.status ?? '')
          "
          :title="
            tr('二维码已过期或请求已拒绝', 'Code expired or request rejected')
          "
          type="info"
          :closable="false"
        /><el-alert
          v-if="vm.mutation.error.value"
          :title="vm.mutation.error.value"
          type="error"
          :closable="false"
        />
      </div>
      <template #footer
        ><template v-if="vm.status.value?.status === 'pending_web_confirm'"
          ><el-button
            type="danger"
            :loading="vm.mutation.busy.value"
            @click="vm.confirm(false)"
            >{{ tr('拒绝', 'Reject') }}</el-button
          ><el-button
            type="primary"
            :loading="vm.mutation.busy.value"
            @click="vm.confirm(true)"
            >{{ tr('确认连接', 'Confirm connection') }}</el-button
          ></template
        ><el-button
          v-else
          :loading="vm.mutation.busy.value"
          @click="vm.generate"
          >{{ tr('生成新二维码', 'Generate new code') }}</el-button
        ><el-button @click="vm.close">{{
          tr('关闭', 'Close')
        }}</el-button></template
      ></el-dialog
    >
    <ManagementDialog
      :model-value="vm.selected.value !== null"
      :title="tr('撤销手机登录', 'Revoke mobile sign-in')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.selected.value = null"
      @submit="vm.revoke"
      ><p>
        {{
          tr('此手机将需要重新登录。', 'This phone will need to sign in again.')
        }}
        {{ vm.selected.value?.clientName }}
      </p></ManagementDialog
    >
  </section>
</template>
