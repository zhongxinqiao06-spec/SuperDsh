<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { authApi } from '@/api/auth/auth-api'
import { accountApi } from '@/api/account/account-api'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import { sessionController } from '@/store/session-controller'
import {
  createPasswordVerifier,
  derivePasswordVerifier,
} from '@/utils/auth/password-verifier'
import { request } from '@/utils/request'
import type { AuthResponse } from '@/types/auth/auth'
const props = defineProps<{
  pending: string
  status: string
  email: string
  name: string
  emailRequired: boolean
}>()
const { tr } = usePreferences(),
  mutation = useMutation(),
  router = useRouter()
const form = reactive({
  email: props.email,
  username: '',
  displayName: props.name,
  password: '',
  confirm: '',
  code: '',
})
async function submit() {
  let response: AuthResponse | null = null
  const succeeded = await mutation.run(async () => {
    let credentials: Record<string, unknown> = {}
    if (props.status === 'needs_password') {
      const { salt } = await request<{ salt: string }>('/auth/password-salt', {
        auth: false,
        method: 'POST',
        body: { identifier: form.email },
      })
      credentials = {
        passwordVerifier: await derivePasswordVerifier(form.password, salt),
      }
    }
    if (props.status === 'needs_registration') {
      if (form.password !== form.confirm || form.password.length < 8)
        throw new Error(
          tr(
            '两次密码须一致且至少8位',
            'Passwords must match and have at least 8 characters',
          ),
        )
      credentials = await createPasswordVerifier(form.password)
    }
    await sessionController.beforeLogin()
    response = await authApi.oauthFinalize({
      pendingToken: props.pending,
      email: form.email,
      username: form.username,
      displayName: form.displayName,
      code: form.code,
      ...credentials,
    })
  })
  if (succeeded && response) {
    sessionController.accept(response)
    form.password = ''
    form.confirm = ''
    await router.replace('/overview')
  }
}
async function sendCode() {
  await mutation.run(() =>
    accountApi.emailCode(form.email, 'register', props.pending),
  )
}
onMounted(() => {
  if (props.status === 'authenticated') void submit()
})
</script>
<template>
  <form class="stack" @submit.prevent="submit">
    <h2>{{ tr('完成第三方登录', 'Complete provider sign-in') }}</h2>
    <el-alert
      v-if="mutation.error.value"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <template v-if="status !== 'authenticated'"
      ><label class="field"
        >{{ tr('邮箱', 'Email')
        }}<el-input v-model="form.email" type="email" /></label
      ><template v-if="status === 'needs_registration'"
        ><label class="field"
          >{{ tr('用户名', 'Username')
          }}<el-input v-model="form.username" /></label
        ><label class="field"
          >{{ tr('显示名称', 'Display name')
          }}<el-input v-model="form.displayName" /></label
      ></template>
      <p v-else>
        {{
          tr(
            '请验证现有账号密码后绑定此第三方身份。',
            'Verify your existing password to link this provider identity.',
          )
        }}
      </p>
      <label class="field"
        >{{ tr('密码', 'Password')
        }}<el-input
          v-model="form.password"
          type="password"
          show-password /></label
      ><template v-if="status === 'needs_registration'"
        ><label class="field"
          >{{ tr('确认密码', 'Confirm password')
          }}<el-input v-model="form.confirm" type="password" /></label
        ><template v-if="emailRequired"
          ><label class="field"
            >{{ tr('验证码', 'Verification code')
            }}<el-input v-model="form.code" /></label
          ><el-button :loading="mutation.busy.value" @click="sendCode">{{
            tr('发送验证码', 'Send code')
          }}</el-button></template
        ></template
      ></template
    ><el-button
      type="primary"
      native-type="submit"
      :loading="mutation.busy.value"
      >{{ tr('继续', 'Continue') }}</el-button
    >
  </form>
</template>
