<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { accountApi } from '@/api/account/account-api'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import { registrationError } from '@/utils/auth/registration-error'

/** 两种新账号注册共用六位验证码，成功发送后按原邮箱倒计时。 */
const props = defineProps<{
  email: string
  available: boolean
  pending?: string
}>()
const code = defineModel<string>({ required: true })
const { tr } = usePreferences()
const sending = useMutation()
const seconds = ref(0)
const sentTo = ref('')
const address = computed(() => props.email.trim().toLowerCase())
const cooldown = computed(() =>
  sentTo.value === address.value ? seconds.value : 0,
)
const canSend = computed(
  () =>
    props.available &&
    !cooldown.value &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address.value),
)
let timer: ReturnType<typeof setInterval> | undefined
watch(address, () => {
  code.value = ''
  sending.error.value = ''
})
onScopeDispose(() => clearInterval(timer))
async function send() {
  const email = address.value
  if (!canSend.value) return
  if (
    !(await sending.run(() =>
      accountApi.emailCode(email, 'register', props.pending),
    ))
  )
    return
  sentTo.value = email
  const deadline = Date.now() + 60000
  seconds.value = 60
  clearInterval(timer)
  timer = setInterval(() => {
    seconds.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    if (!seconds.value) clearInterval(timer)
  }, 1000)
}
</script>
<template>
  <div class="field">
    <label for="registration-code">{{
      tr('验证码', 'Verification code')
    }}</label>
    <div class="registration-code-row">
      <el-input
        id="registration-code"
        v-model="code"
        autocomplete="one-time-code"
        inputmode="numeric"
        maxlength="6"
      />
      <el-button
        native-type="button"
        :disabled="!canSend"
        :loading="sending.busy.value"
        @click="send"
        >{{
          cooldown
            ? tr(`${cooldown} 秒后重发`, `Resend in ${cooldown}s`)
            : tr('发送验证码', 'Send code')
        }}</el-button
      >
    </div>
    <small v-if="!available" role="status">{{
      tr(
        '暂时无法发送验证邮件，请稍后重试。',
        'Verification email is unavailable. Please try again later.',
      )
    }}</small>
    <small v-else-if="sentTo === address && sentTo" role="status">{{
      tr(
        '验证码已发送，10 分钟内有效。',
        'Code sent. It expires in 10 minutes.',
      )
    }}</small>
    <small v-if="sending.error.value" role="alert">{{
      registrationError(sending.error.value, tr)
    }}</small>
  </div>
</template>
