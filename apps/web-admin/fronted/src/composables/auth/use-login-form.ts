import { computed, onScopeDispose, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { authApi } from '@/api/auth/auth-api'
import { sessionController } from '@/store/session-controller'
import { useAuthStore } from '@/store/modules/auth-store'
import { canonicalPath } from '@/utils/console/routes'
import type { AuthResponse } from '@/types/auth/auth'
import { accountApi } from '@/api/account/account-api'
import { authContinuation } from '@/utils/auth/native-oauth'

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
    username: '',
    displayName: '',
    email: '',
    code: '',
  })
  const abort = new AbortController()
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
        !resource.data.value.registrationOpen ||
        !/^[a-z0-9_-]{3,32}$/.test(form.username) ||
        !form.displayName.trim() ||
        form.password.length < 8 ||
        form.password !== form.confirm
      ) {
        mutation.error.value =
          '请检查用户名（3–32位小写字母、数字、下划线）、显示名称与两次密码（至少8位）'
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
            username: form.username,
            displayName: form.displayName.trim(),
            password: form.password,
            ...(form.email ? { email: form.email } : {}),
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
      const target =
        typeof route.query.returnTo === 'string'
          ? canonicalPath(route.query.returnTo, auth.session?.permissions)
          : null
      await router.replace(
        authContinuation(route.query.returnTo) ?? target ?? '/overview',
      )
    }
  }
  async function sendCode() {
    await mutation.run(() => accountApi.emailCode(form.email, 'register'))
  }
  async function oauth() {
    await mutation.run(async () => {
      const value = await authApi.oauthStart(`${location.origin}/login`)
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
    sendCode,
    oauth,
  }
}
