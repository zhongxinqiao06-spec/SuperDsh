<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { useProfile } from '@/composables/account/use-profile'
import { usePreferences } from '@/store/modules/preferences'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
/** 资料页展示已保存信息，分区弹窗承载草稿，取消不影响当前身份。 */
const vm = useProfile()
const { tr } = usePreferences()
</script>
<template>
  <section class="page settings-page">
    <PageHeader :title="tr('个人资料', 'My profile')" />
    <el-alert v-if="vm.notice.value" :title="vm.notice.value" type="success" />
    <SettingsCard :title="tr('账号', 'Account')">
      <div class="settings-row">
        <div class="profile-heading">
          <el-avatar :size="64" :src="vm.auth.session?.avatar || undefined">{{
            vm.auth.session?.displayName?.slice(0, 2)
          }}</el-avatar>
          <div>
            <strong>{{ vm.auth.session?.displayName }}</strong
            ><small>{{
              vm.auth.session?.role === 'admin' ? 'Admin' : 'Member'
            }}</small>
          </div>
        </div>
        <el-button @click="vm.edit('avatar')">{{
          tr('更换头像', 'Change avatar')
        }}</el-button>
      </div>
      <dl class="settings-details">
        <div>
          <dt>{{ tr('登录邮箱', 'Sign-in email') }}</dt>
          <dd>{{ vm.auth.session?.email || '—' }}</dd>
        </div>
        <div>
          <dt>{{ tr('角色', 'Roles') }}</dt>
          <dd>{{ vm.auth.session?.roles.join(', ') }}</dd>
        </div>
        <div>
          <dt>{{ tr('账号状态', 'Account status') }}</dt>
          <dd>{{ tr('活跃', 'Active') }}</dd>
        </div>
      </dl>
    </SettingsCard>
    <SettingsCard
      :title="tr('昵称与邮箱', 'Name and email')"
      :description="
        tr(
          '昵称用于展示，邮箱用于登录。',
          'Your name is displayed; your email is used to sign in.',
        )
      "
    >
      <template #action
        ><el-button @click="vm.edit('name')">{{
          tr('修改昵称', 'Edit name')
        }}</el-button></template
      >
      <div class="settings-row">
        <span class="settings-row-label">{{
          tr('显示名称', 'Display name')
        }}</span
        ><span>{{ vm.auth.session?.displayName }}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">{{
          tr('登录邮箱', 'Sign-in email')
        }}</span>
        <div class="settings-row-value">
          <span>{{ vm.auth.session?.email || '—' }}</span
          ><el-button @click="vm.edit('email')">{{
            tr('绑定邮箱', 'Bind email')
          }}</el-button>
        </div>
      </div>
    </SettingsCard>
    <ManagementDialog
      :model-value="vm.editing.value === 'name'"
      :title="tr('修改昵称', 'Edit name')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.saveName"
      ><label class="field"
        >{{ tr('显示名称', 'Display name')
        }}<el-input
          v-model="vm.form.displayName"
          maxlength="64"
          required /></label
    ></ManagementDialog>
    <ManagementDialog
      :model-value="vm.editing.value === 'email'"
      :title="tr('绑定邮箱', 'Bind email')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.saveEmail"
      ><label class="field"
        >{{ tr('邮箱', 'Email')
        }}<el-input v-model="vm.form.email" type="email" required /></label
      ><template v-if="vm.config.data.value?.emailVerificationRequired"
        ><label class="field"
          >{{ tr('验证码', 'Verification code')
          }}<el-input
            v-model="vm.form.code"
            autocomplete="one-time-code" /></label
        ><el-button :loading="vm.mutation.busy.value" @click="vm.sendCode">{{
          tr('发送验证码', 'Send code')
        }}</el-button></template
      ></ManagementDialog
    >
    <el-dialog
      :model-value="vm.editing.value === 'avatar'"
      :title="tr('更换头像', 'Change avatar')"
      width="min(480px,94vw)"
      @update:model-value="vm.editing.value = null"
      ><div class="stack">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          :aria-label="tr('上传头像', 'Upload avatar')"
          :disabled="vm.mutation.busy.value"
          @change="vm.upload"
        /><el-button
          v-if="vm.auth.session?.avatar"
          :disabled="vm.mutation.busy.value"
          @click="vm.removeAvatar"
          >{{ tr('移除头像', 'Remove avatar') }}</el-button
        ><el-alert
          v-if="vm.mutation.error.value"
          :title="vm.mutation.error.value"
          type="error"
          :closable="false"
        /></div
    ></el-dialog>
  </section>
</template>
