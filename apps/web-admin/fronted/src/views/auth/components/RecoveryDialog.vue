<script setup lang="ts">
import { reactive, ref } from 'vue'
import { authApi } from '@/api/auth/auth-api'
import { accountApi } from '@/api/account/account-api'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
const open = defineModel<boolean>({ required: true })
defineProps<{ emailEnabled: boolean }>()
const { tr } = usePreferences(),
  mutation = useMutation(),
  useEmail = ref(false),
  success = ref(false)
const form = reactive({
  identifier: '',
  email: '',
  code: '',
  recoveryCode: '',
  password: '',
  confirm: '',
})
async function submit() {
  if (form.password.length < 8 || form.password !== form.confirm) {
    mutation.error.value = tr(
      '密码至少8位且两次输入一致',
      'Passwords must match and have at least 8 characters',
    )
    return
  }
  if (await mutation.run(() => authApi.recover(form, useEmail.value))) {
    success.value = true
    form.password = ''
    form.confirm = ''
    form.recoveryCode = ''
    form.code = ''
  }
}
async function sendCode() {
  await mutation.run(() => accountApi.emailCode(form.email, 'reset'))
}
</script>
<template>
  <ManagementDialog
    v-model="open"
    :title="tr('找回账号', 'Recover account')"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    @submit="submit"
  >
    <el-alert
      v-if="success"
      :title="
        tr(
          '密码已重置，请关闭并重新登录。',
          'Password reset. Close this dialog and sign in.',
        )
      "
      type="success"
      :closable="false"
    />
    <el-switch
      v-if="emailEnabled"
      v-model="useEmail"
      :active-text="tr('通过邮箱找回', 'Recover by email')"
      :inactive-text="tr('使用恢复码', 'Use a recovery code')"
    />
    <template v-if="useEmail"
      ><label class="field"
        >{{ tr('已验证邮箱', 'Verified email')
        }}<el-input v-model="form.email" type="email" /></label
      ><label class="field"
        >{{ tr('验证码', 'Verification code')
        }}<el-input v-model="form.code" /></label
      ><el-button :loading="mutation.busy.value" @click="sendCode">{{
        tr('发送验证码', 'Send code')
      }}</el-button></template
    >
    <template v-else
      ><label class="field"
        >{{ tr('用户名或邮箱', 'Username or email')
        }}<el-input v-model="form.identifier" /></label
      ><label class="field"
        >{{ tr('恢复码', 'Recovery code')
        }}<el-input v-model="form.recoveryCode" /></label
    ></template>
    <label class="field"
      >{{ tr('新密码', 'New password')
      }}<el-input
        v-model="form.password"
        type="password"
        show-password
        autocomplete="new-password" /></label
    ><label class="field"
      >{{ tr('确认密码', 'Confirm password')
      }}<el-input
        v-model="form.confirm"
        type="password"
        show-password
        autocomplete="new-password"
    /></label>
  </ManagementDialog>
</template>
