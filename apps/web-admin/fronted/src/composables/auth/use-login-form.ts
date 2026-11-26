import { computed, h, onScopeDispose, reactive, watch } from 'vue'
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
import { ElNotification } from 'element-plus'

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
  })
  watch(
    () => route.path,
    (path) => {
      if (
        path === '/login' &&
        typeof history.state?.registrationEmail === 'string'
      )
        form.identifier = history.state.registrationEmail
    },
    { immediate: true },
  )
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
    if (register.value) return
    if (!form.identifier.trim() || !form.password) {
      mutation.error.value = '请输入账号和密码'
      return
    }
    let response: AuthResponse | null = null
    const success = await mutation.run(async () => {
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
      await router.replace(
        signedInDestination(route.query.returnTo, auth.session?.permissions),
      )
    }
  }
  async function registered(result: AuthResponse) {
    sessionController.accept(result)
    const destination = signedInDestination(
      route.query.returnTo,
      auth.session?.permissions,
    )
    const generation = sessionController.generation
    await router.replace(destination)
    if (generation !== sessionController.generation) return
    const grant = result.registrationGrant
    if (!grant) return
    const expiry = new Date(grant.expiresAt).toLocaleDateString()
    const link = router.resolve('/account/membership').href
    ElNotification({
      title: tr('注册成功', 'Account created'),
      message: h('div', [
        h(
          'p',
          tr(
            `体验额度已到账 ${grant.points} 点，有效期至 ${expiry}。`,
            `${grant.points} credits received. Valid until ${expiry}.`,
          ),
        ),
        h('a', { href: link }, tr('查看我的额度明细', 'View credit details')),
      ]),
      type: 'success',
      duration: 10000,
    })
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
    registered,
    product,
    mailAvailable,
    oauth,
  }
}
