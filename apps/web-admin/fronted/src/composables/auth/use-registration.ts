import { computed, onScopeDispose, ref, watch } from 'vue'
import { accountApi } from '@/api/account/account-api'
import { authApi } from '@/api/auth/auth-api'
import { usePreferences } from '@/store/modules/preferences'
import { ApiError, errorMessage } from '@/utils/errors'
import { registrationError } from '@/utils/auth/registration-error'
import type { Product } from '@/types/console/navigation'
import type { AuthResponse } from '@/types/auth/auth'

interface Challenge {
  email: string
  expires: number
  retry: number
  sent: boolean
}

/** 当前标签页只保存邮箱和服务端时间窗口；密码、验证码和登录信息始终留在内存。 */
function readChallenge(key: string): Challenge | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (
      saved &&
      typeof saved.email === 'string' &&
      typeof saved.sent === 'boolean' &&
      Number.isFinite(saved.expires) &&
      Number.isFinite(saved.retry) &&
      Math.max(saved.expires, saved.retry) > Date.now() - 86400000
    )
      return saved
  } catch {
    /* 存储受限时仍可在当前页面完成注册。 */
  }
  return null
}

/** 两步公开注册。只有成功发码或恢复同一张发码回执后，才允许提交建号。 */
export function useRegistration(
  product: Product,
  complete: (result: AuthResponse) => void,
) {
  const { tr } = usePreferences()
  const key = 'starbridge.registration.' + product
  const challenge = ref(readChallenge(key))
  const email = ref(challenge.value?.email ?? '')
  const verifying = ref(challenge.value?.sent === true)
  const code = ref(''),
    password = ref('')
  const busy = ref<'send' | 'register' | null>(null)
  const field = ref<'email' | 'code' | 'password' | 'form' | null>(null)
  const message = ref(''),
    notice = ref(''),
    offerLogin = ref(false)
  const address = computed(() => email.value.trim().toLowerCase())
  const matches = computed(() => challenge.value?.email === address.value)
  const now = ref(Date.now())
  const wait = computed(() =>
    matches.value
      ? Math.max(
          0,
          Math.ceil(((challenge.value?.retry ?? 0) - now.value) / 1000),
        )
      : 0,
  )
  const expired = computed(
    () => verifying.value && (challenge.value?.expires ?? 0) <= now.value,
  )
  const controller = new AbortController()
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 500)
  onScopeDispose(() => {
    controller.abort()
    clearInterval(timer)
  })
  watch(
    challenge,
    (value) => {
      try {
        if (value) sessionStorage.setItem(key, JSON.stringify(value))
        else sessionStorage.removeItem(key)
      } catch {
        /* 无存储权限时只维持内存状态。 */
      }
    },
    { flush: 'sync' },
  )
  function clearError() {
    field.value = null
    message.value = ''
    offerLogin.value = false
  }
  watch(address, () => {
    clearError()
    notice.value = ''
  })
  function fail(target: typeof field.value, detail: string) {
    field.value = target
    message.value = detail
  }
  function report(error: unknown, sending: boolean) {
    const reason = error instanceof ApiError ? error.code : undefined
    const retry = error instanceof ApiError ? error.retryAfter : undefined
    if (retry !== undefined) {
      const previous = matches.value ? challenge.value : null
      challenge.value = {
        email: address.value,
        sent: previous?.sent ?? false,
        expires: previous?.expires ?? 0,
        retry: Date.now() + retry * 1000,
      }
      now.value = Date.now()
    }
    if (
      reason === 'verification_code_expired' &&
      matches.value &&
      challenge.value
    )
      challenge.value = { ...challenge.value, expires: 0 }
    const raw = errorMessage(error)
    offerLogin.value =
      reason === 'registration_conflict' ||
      /already in use/.test(raw) ||
      (!sending && error instanceof ApiError && error.status === 0)
    const target = sending
      ? verifying.value
        ? 'form'
        : 'email'
      : reason?.startsWith('verification_') ||
          raw === 'invalid or expired verification code'
        ? 'code'
        : 'form'
    fail(target, registrationError(raw, tr, reason))
  }
  async function send() {
    if (busy.value || wait.value) return
    clearError()
    notice.value = ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address.value)) {
      fail(
        'email',
        tr('请输入完整的邮箱地址。', 'Enter a valid email address.'),
      )
      return
    }
    busy.value = 'send'
    try {
      const receipt = await accountApi.emailCode(
        address.value,
        'register',
        '',
        controller.signal,
      )
      if (controller.signal.aborted) return
      // 使用服务端相对时长换算成本地截止时间，避免浏览器和服务端时钟偏差。
      const local = Date.now(),
        server = Date.parse(receipt.serverTime) || local
      const until = (date: string | undefined, fallback: number) =>
        date ? local + Date.parse(date) - server : local + fallback
      challenge.value = {
        email: address.value,
        sent: true,
        expires: until(receipt.expiresAt, 600000),
        retry: until(receipt.resendAt, 60000),
      }
      code.value = ''
      now.value = local
      verifying.value = true
      notice.value = tr(
        '验证码已发送，请查看最新一封邮件。',
        'Code sent. Check your latest email.',
      )
    } catch (error) {
      if (!controller.signal.aborted) report(error, true)
    } finally {
      busy.value = null
    }
  }
  function edit() {
    if (busy.value) return
    clearError()
    notice.value = ''
    code.value = ''
    password.value = ''
    verifying.value = false
  }
  function resume() {
    if (matches.value && challenge.value?.sent) {
      clearError()
      verifying.value = true
    }
  }
  async function register() {
    if (
      busy.value ||
      !verifying.value ||
      !matches.value ||
      !challenge.value?.sent
    )
      return
    clearError()
    notice.value = ''
    if (expired.value) {
      fail(
        'code',
        tr(
          '验证码已过期，请重新发送。',
          'This code expired. Request a new one.',
        ),
      )
      return
    }
    if (!/^\d{6}$/u.test(code.value)) {
      fail(
        'code',
        tr('请输入邮件中的 6 位数字。', 'Enter the six digits in your email.'),
      )
      return
    }
    if (password.value.length < 8) {
      fail(
        'password',
        tr('密码至少需要 8 个字符。', 'Use at least 8 characters.'),
      )
      return
    }
    busy.value = 'register'
    try {
      const result = await authApi.register(
        {
          email: address.value,
          password: password.value,
          code: code.value,
          product,
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      challenge.value = null
      password.value = ''
      code.value = ''
      complete(result)
    } catch (error) {
      if (!controller.signal.aborted) report(error, false)
    } finally {
      busy.value = null
    }
  }
  return {
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
  }
}
