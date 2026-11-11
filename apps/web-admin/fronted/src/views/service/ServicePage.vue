<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { useService } from '@/composables/service/use-service'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import OAuthSettingsForm from '@/views/service/components/OAuthSettingsForm.vue'
import ServiceInformationCard from '@/views/service/components/ServiceInformationCard.vue'
/** 服务配置沿用摘要卡与分区弹窗，编辑时复制已保存配置，取消不提交。 */
const vm = useService(),
  { tr } = usePreferences()
</script>
<template>
  <section class="page settings-page service-page">
    <PageHeader :title="tr('服务', 'Service')" />
    <div class="toolbar toolbar-panel">
      <el-button @click="vm.resource.reload">{{
        tr('刷新', 'Refresh')
      }}</el-button>
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    />
    <el-alert v-if="vm.notice.value" :title="vm.notice.value" type="success" />
    <template v-if="vm.resource.data.value && vm.settings.value">
      <ServiceInformationCard
        :information="vm.resource.data.value.information"
      />
      <SettingsCard
        :title="tr('访问', 'Access')"
        :description="
          tr(
            '控制谁可以为这个实例创建账号。',
            'Control who may create an account on this instance.',
          )
        "
        ><template #action
          ><el-button @click="vm.edit('access')">{{
            tr('编辑配置', 'Edit settings')
          }}</el-button></template
        >
        <div class="settings-row">
          <span>{{ tr('开放注册', 'Open registration') }}</span
          ><el-tag>{{
            vm.resource.data.value.settings.registrationOpen
              ? tr('已开放', 'Open')
              : tr('已关闭', 'Closed')
          }}</el-tag>
        </div>
        <div class="settings-row">
          <span>OAuth {{ tr('注册', 'registration') }}</span
          ><el-tag>{{
            vm.resource.data.value.settings.oauthRegistrationOpen
              ? tr('已开放', 'Open')
              : tr('已关闭', 'Closed')
          }}</el-tag>
        </div></SettingsCard
      >
      <SettingsCard
        :title="tr('邮箱验证 · Resend', 'Email verification · Resend')"
        :description="
          tr(
            '配置 Resend 发件服务和邮箱验证码要求。',
            'Configure the Resend sender and email verification requirements.',
          )
        "
        ><template #action
          ><el-button @click="vm.edit('email')">{{
            tr('编辑配置', 'Edit settings')
          }}</el-button></template
        >
        <div class="settings-row">
          <div class="settings-row-value">
            <el-tag>{{
              vm.resource.data.value.settings.email.enabled
                ? tr('已启用', 'Enabled')
                : tr('未启用', 'Disabled')
            }}</el-tag
            ><span>{{
              vm.resource.data.value.settings.email.fromAddress ||
              tr('未设置发件人', 'Sender not configured')
            }}</span
            ><el-tag>{{
              vm.resource.data.value.settings.email.apiKeyConfigured
                ? tr('密钥已配置', 'Key configured')
                : tr('未配置密钥', 'No key configured')
            }}</el-tag>
          </div>
        </div></SettingsCard
      >
      <SettingsCard
        :title="tr('公告', 'Announcement')"
        :description="
          tr(
            '在登录、注册和主界面向用户展示公告。',
            'Display announcements on sign-in, registration and the main interface.',
          )
        "
        ><template #action
          ><el-button @click="vm.edit('announcement')">{{
            tr('编辑公告', 'Edit announcement')
          }}</el-button></template
        >
        <div class="settings-row">
          <p>
            {{
              vm.resource.data.value.announcement.enabled
                ? tr('公告已启用', 'Announcement enabled')
                : tr('公告未启用', 'Announcement disabled')
            }}
          </p>
        </div>
        <div
          v-if="vm.resource.data.value.announcement.markdown"
          class="settings-row"
        >
          <p>{{ vm.resource.data.value.announcement.markdown }}</p>
        </div></SettingsCard
      >
      <SettingsCard
        title="OAuth"
        :description="
          tr(
            '配置第三方身份提供方和授权登录。',
            'Configure an identity provider for federated sign-in.',
          )
        "
        ><template #action
          ><el-button @click="vm.edit('oauth')">{{
            tr('编辑配置', 'Edit settings')
          }}</el-button></template
        >
        <div class="settings-row">
          <span>{{
            vm.resource.data.value.settings.oauth?.label || 'OAuth'
          }}</span
          ><el-tag>{{
            vm.resource.data.value.settings.oauth?.enabled
              ? tr('已启用', 'Enabled')
              : tr('未启用', 'Disabled')
          }}</el-tag>
        </div></SettingsCard
      >
      <ManagementDialog
        :model-value="vm.editing.value === 'access'"
        :title="tr('访问', 'Access')"
        :busy="vm.mutation.busy.value"
        :error="vm.mutation.error.value"
        @update:model-value="vm.editing.value = null"
        @submit="vm.save"
        ><el-switch
          v-model="vm.settings.value.registrationOpen"
          :active-text="tr('开放注册', 'Open registration')" /><el-switch
          v-model="vm.settings.value.oauthRegistrationOpen"
          :active-text="tr('OAuth 注册', 'OAuth registration')"
      /></ManagementDialog>
      <ManagementDialog
        :model-value="vm.editing.value === 'email'"
        :title="tr('邮箱验证 · Resend', 'Email verification · Resend')"
        :busy="vm.mutation.busy.value"
        :error="vm.mutation.error.value"
        @update:model-value="vm.editing.value = null"
        @submit="vm.save"
        ><el-switch
          v-model="vm.settings.value.email.enabled"
          :active-text="tr('启用邮件验证', 'Enable email verification')"
        /><label class="field"
          >{{ tr('发件人地址', 'Sender address')
          }}<el-input
            v-model="vm.settings.value.email.fromAddress"
            placeholder="Platform <noreply@example.com>" /></label
        ><label class="field"
          >{{ tr('Resend API 密钥', 'Resend API key')
          }}<el-input
            v-model="vm.settings.value.email.apiKey"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="
              vm.settings.value.email.apiKeyConfigured
                ? tr('已配置，留空保留', 'Configured; leave blank to keep')
                : tr('尚未配置', 'Not configured')
            " /></label
        ><el-checkbox v-model="vm.settings.value.email.clearApiKey">{{
          tr('清除已保存邮件密钥', 'Clear saved email key')
        }}</el-checkbox></ManagementDialog
      >
      <ManagementDialog
        :model-value="vm.editing.value === 'oauth'"
        title="OAuth"
        :busy="vm.mutation.busy.value"
        :error="vm.mutation.error.value"
        @update:model-value="vm.editing.value = null"
        @submit="vm.save"
        ><OAuthSettingsForm v-model="vm.settings.value.oauth"
      /></ManagementDialog>
      <ManagementDialog
        :model-value="vm.editing.value === 'announcement'"
        :title="tr('编辑公告', 'Edit announcement')"
        :busy="vm.mutation.busy.value"
        :error="vm.mutation.error.value"
        @update:model-value="vm.editing.value = null"
        @submit="vm.publish"
        ><el-switch
          v-model="vm.announcement.enabled"
          :active-text="tr('发布公告', 'Publish announcement')"
        /><label class="field"
          >{{ tr('公告内容（Markdown）', 'Announcement (Markdown)')
          }}<el-input
            v-model="vm.announcement.markdown"
            type="textarea"
            :rows="8"
            maxlength="20000"
            show-word-limit
        /></label>
        <p class="muted">
          {{
            tr(
              '内容更新后，用户需要重新阅读确认。',
              'Users must acknowledge changed announcements again.',
            )
          }}
        </p></ManagementDialog
      >
    </template>
  </section>
</template>
