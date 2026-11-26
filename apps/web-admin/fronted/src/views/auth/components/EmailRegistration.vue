<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Hide, View } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'
import { useRegistration } from '@/composables/auth/use-registration'
import { usePreferences } from '@/store/modules/preferences'
import type { AuthResponse } from '@/types/auth/auth'
import type { Product } from '@/types/console/navigation'
import type { InputInstance } from 'element-plus'
import AppIcon from '@/components/base/AppIcon.vue'

/** 邮箱先发码再建号，两步共享入口上下文，OAuth 续接仍使用专用表单。 */
const props = defineProps<{
  product: Product
  available: boolean
  oauthLabel?: string | null
}>()
const emit = defineEmits<{
  registered: [result: AuthResponse]
  retry: []
  oauth: []
}>()
const { tr } = usePreferences(),
  route = useRoute()
const {
  challenge,
  email,
  address,
  verifying,
  code,
  password,
  busy,
  field,
  message,
  notice,
  offerLogin,
  wait,
  expired,
  matches,
  clearError,
  send,
  edit,
  resume,
  register,
} = useRegistration(props.product, (r) => emit('registered', r))
const passwordVisible = ref(false)
const emailInput = ref<InputInstance>(),
  codeInput = ref<InputInstance>(),
  passwordInput = ref<InputInstance>()
function focusField() {
  if (field.value === 'password') passwordInput.value?.focus()
  else if (verifying.value) codeInput.value?.focus()
  else emailInput.value?.focus()
}
async function submit() {
  if (!props.available) return
  if (verifying.value) await register()
  else await send()
  if (field.value) {
    await nextTick()
    focusField()
  }
}
watch(verifying, async () => {
  passwordVisible.value = false
  await nextTick()
  focusField()
})
</script>
<template>
  <form
    class="login-form registration-form"
    novalidate
    @submit.prevent="submit"
  >
    <div class="login-fields">
      <p class="registration-step">
        {{
          verifying
            ? tr(
                '第 2 步，共 2 步 · 验证邮箱并设置密码',
                'Step 2 of 2 · Verify email and set a password',
              )
            : tr(
                '第 1 步，共 2 步 · 填写邮箱',
                'Step 1 of 2 · Enter your email',
              )
        }}
      </p>
      <template v-if="!available">
        <p role="status">
          {{
            tr(
              '注册邮件服务暂时不可用，请稍后重试。',
              'Verification email is temporarily unavailable.',
            )
          }}
        </p>
        <el-button native-type="button" @click="emit('retry')">{{
          tr('重新检查', 'Check again')
        }}</el-button>
      </template>
      <template v-else-if="!verifying">
        <label class="field" for="signup-email"
          >{{ tr('邮箱', 'Email') }}
          <el-input
            id="signup-email"
            ref="emailInput"
            v-model="email"
            type="email"
            autocomplete="email"
            autocapitalize="none"
            :spellcheck="false"
            maxlength="254"
            :readonly="!!busy"
            :aria-invalid="field === 'email'"
            aria-describedby="signup-email-note"
            placeholder="name@example.com"
          />
        </label>
        <small
          id="signup-email-note"
          :role="field === 'email' ? 'alert' : undefined"
          :class="{ 'registration-error': field === 'email' }"
          >{{
            field === 'email'
              ? message
              : tr(
                  '用于接收验证码，之后也可以用这个邮箱登录。',
                  'Receive a code here and use this email to sign in.',
                )
          }}</small
        >
        <button
          v-if="matches && challenge?.sent"
          type="button"
          class="login-text-action"
          :disabled="!!busy"
          @click="resume"
        >
          {{ tr('继续验证这个邮箱', 'Continue verifying this email') }}
        </button>
      </template>
      <template v-else>
        <div class="registration-address">
          <span
            >{{ tr('接收邮箱', 'Sent to') }}
            <strong>{{ address }}</strong></span
          ><button
            type="button"
            class="login-text-action"
            :disabled="!!busy"
            @click="edit"
          >
            {{ tr('修改邮箱', 'Change email') }}
          </button>
        </div>
        <div class="field">
          <label for="signup-code">{{
            tr('验证码', 'Verification code')
          }}</label>
          <el-input
            id="signup-code"
            ref="codeInput"
            v-model="code"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            :readonly="!!busy"
            :placeholder="tr('邮件中的 6 位数字', '6 digits from your email')"
            :aria-invalid="field === 'code'"
            aria-describedby="signup-code-note"
            @input="field === 'code' && clearError()"
          />
          <div class="registration-address">
            <small
              id="signup-code-note"
              :role="field === 'code' ? 'alert' : undefined"
              :class="{ 'registration-error': field === 'code' }"
              >{{
                field === 'code'
                  ? message
                  : expired
                    ? tr(
                        '验证码已过期，请重新发送。',
                        'Code expired. Request a new one.',
                      )
                    : tr(
                        '验证码 10 分钟内有效。',
                        'Codes are valid for 10 minutes.',
                      )
              }}</small
            >
            <button
              class="login-text-action"
              type="button"
              :disabled="!!busy || !!wait"
              @click="send"
            >
              {{
                wait
                  ? tr(`${wait} 秒后重发`, `Resend in ${wait}s`)
                  : busy === 'send'
                    ? tr('发送中…', 'Sending…')
                    : tr('重新发送', 'Resend code')
              }}
            </button>
          </div>
        </div>
        <div class="field">
          <label for="signup-password">{{
            tr('设置密码', 'Set password')
          }}</label>
          <el-input
            id="signup-password"
            ref="passwordInput"
            v-model="password"
            :type="passwordVisible ? 'text' : 'password'"
            autocomplete="new-password"
            :readonly="!!busy"
            :aria-invalid="field === 'password'"
            aria-describedby="signup-password-note"
            @input="field === 'password' && clearError()"
            ><template #suffix
              ><button
                type="button"
                class="login-eye"
                :aria-pressed="passwordVisible"
                :aria-label="
                  passwordVisible
                    ? tr('隐藏密码', 'Hide password')
                    : tr('显示密码', 'Show password')
                "
                @click="passwordVisible = !passwordVisible"
              >
                <component
                  :is="passwordVisible ? View : Hide"
                  aria-hidden="true"
                /></button></template
          ></el-input>
          <small
            id="signup-password-note"
            :role="field === 'password' ? 'alert' : undefined"
            :class="{ 'registration-error': field === 'password' }"
            >{{
              field === 'password'
                ? message
                : tr('至少 8 个字符。', 'Use at least 8 characters.')
            }}</small
          >
        </div>
        <small v-if="notice" role="status">{{ notice }}</small>
      </template>
    </div>
    <div class="login-actions">
      <p v-if="field === 'form'" class="registration-error" role="alert">
        {{ message }}
      </p>
      <button
        v-if="available"
        type="submit"
        class="login-submit"
        :disabled="!!busy || (!verifying && !!wait)"
        :aria-busy="!!busy"
      >
        <span class="login-submit-label"
          >{{
            busy === 'register'
              ? tr('正在创建账号…', 'Creating account…')
              : busy === 'send' && !verifying
                ? tr('发送中…', 'Sending…')
                : verifying
                  ? tr('验证并创建账号', 'Verify and create account')
                  : wait
                    ? tr(`${wait} 秒后可重发`, `Retry in ${wait}s`)
                    : tr('发送验证码', 'Send verification code')
          }}<AppIcon v-if="!busy" name="arrow-right" :size="15" /><i
            v-else
            class="login-spinner"
            aria-hidden="true"
        /></span>
      </button>
      <details v-if="verifying && available" class="registration-help">
        <summary>{{ tr('没收到邮件？', 'Didn’t receive an email?') }}</summary>
        <p>
          {{
            tr(
              '核对邮箱拼写，查看垃圾箱或广告邮件。倒计时结束后可重新发送，请使用最新一封邮件中的验证码。',
              'Check the address and your spam folder. After the countdown, request a new message and use its code.',
            )
          }}
        </p>
      </details>
      <el-button
        v-if="oauthLabel && !verifying"
        native-type="button"
        @click="emit('oauth')"
        >{{ tr('使用第三方账号登录', 'Sign in with provider') }} ·
        {{ oauthLabel }}</el-button
      >
      <router-link
        class="login-register"
        :to="{
          path: '/login',
          query: route.query,
          state: { registrationEmail: address },
        }"
        >{{
          offerLogin
            ? tr('用此邮箱登录', 'Sign in with this email')
            : tr('已有账号，登录', 'Already have an account? Sign in')
        }}</router-link
      >
      <p class="login-legal">
        {{ tr('继续操作即表示你已了解', 'By continuing, you acknowledge the') }}
        <router-link to="/privacy">{{
          tr('隐私说明', 'Privacy notice')
        }}</router-link>
      </p>
    </div>
  </form>
</template>
