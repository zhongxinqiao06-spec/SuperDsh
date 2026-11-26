import { computed, onScopeDispose, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { authApi } from '@/api/auth/auth-api'
import { sessionController } from '@/store/session-controller'
import { useAuthStore } from '@/store/modules/auth-store'
import type { AuthResponse } from '@/types/auth/auth'
import { signedInDestination } from '@/utils/auth/native-oauth'
import { productOf } from '@/utils/studio/products'
import { usePreferences } from '@/store/modules/preferences'

/** 登录与开放注册表单；管理员由服务端配置初始化，失败保留输入。 */
export function useLoginForm() {
  const router = useRouter(),
    route = useRoute(),
    auth = useAuthStore()
  const resource = useResource(authApi.config),
    mutation = useMutation()
  const form = reactive({
    identifier: '',
    password: '',
    confirm: '',
    email: '',
    code: '',
  })
  const abort = new AbortController()
  const { tr } = usePreferences()
  const product = computed(
    () =>
      productOf(route.query.product) ??
      (typeof route.query.returnTo === 'string' &&
      /^\/entertainment(?:\/|\?|$)/u.test(route.query.returnTo)
        ? 'entertainment'
        : 'office'),
  )
  const mailAvailable = computed(
    () =>
      resource.data.value?.registrationEmailAvailable ??
      resource.data.value?.emailVerificationRequired ??
      false,
  )
  onScopeDispose(() => abort.abort())
  const initializationPending = computed(
    () => resource.data.value?.needsBootstrap === true,
  )
  const register = computed(
    () =>
      !initializationPending.value &&
      resource.data.value?.registrationOpen === true &&
      route.path === '/register',
  )
  async function submit(): Promise<void> {
    // 首个管理员只能由服务端初始化；禁止从遗留入口降为匿名注册请求。
    if (!resource.data.value || initializationPending.value) return
    if (register.value) {
      if (
        !mailAvailable.value ||
        !form.email.trim() ||
        !/^\d{6}$/u.test(form.code) ||
        form.password.length < 8 ||
        form.password !== form.confirm
      ) {
        mutation.error.value = tr(
          '请输入邮箱、六位验证码和两次一致的密码（至少 8 位）。',
          'Enter your email, six-digit code and matching passwords (at least 8 characters).',
        )
        return
      }
    } else if (!form.identifier.trim() || !form.password) {
      mutation.error.value = '请输入账号和密码'
      return
    }
    let response: AuthResponse | null = null
    const success = await mutation.run(async () => {
      if (register.value) {
        response = await authApi.register(
          {
            password: form.password,
            email: form.email.trim(),
            product: product.value,
            code: form.code,
          },
          abort.signal,
        )
      } else
        response = await authApi.login(
          form.identifier,
          form.password,
          abort.signal,
        )
    })
    if (success && response && !abort.signal.aborted) {
      // 只有仍挂载的认证页面才能发布新身份；发布后再跳转，避免把正常换代际误判为迟到结果。
      sessionController.accept(response)
      form.password = ''
      form.confirm = ''
      await router.replace(
        signedInDestination(route.query.returnTo, auth.session?.permissions),
      )
    }
  }
  async function oauth() {
    await mutation.run(async () => {
      const callback = new URL('/login', location.origin)
      callback.searchParams.set('product', product.value)
      if (typeof route.query.returnTo === 'string')
        callback.searchParams.set('returnTo', route.query.returnTo)
      const value = await authApi.oauthStart(callback.href)
      location.assign(value.authorizeUrl)
    })
  }
  return {
    resource,
    mutation,
    form,
    initializationPending,
    register,
    submit,
    product,
    mailAvailable,
    oauth,
  }
}
