import { onScopeDispose, ref, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { authApi } from '@/api/auth/auth-api'
import { sessionController } from '@/store/session-controller'
import { accountApi, type LoginSession } from '@/api/account/account-api'

/** 账号安全用例：密码仅驻留当前页面，成功或关闭编辑时清除。 */
export function useSecurity() {
  const page = ref(1),
    pageSize = ref(10),
    search = ref(''),
    appliedSearch = ref('')
  const resource = useResource((signal) =>
    accountApi.sessions(signal, {
      page: page.value,
      pageSize: pageSize.value,
      search: appliedSearch.value,
    }),
  )
  watch(page, () => void resource.reload())
  watch(pageSize, () => {
    if (page.value !== 1) page.value = 1
    else void resource.reload()
  })
  function applySearch() {
    appliedSearch.value = search.value.trim()
    if (page.value !== 1) page.value = 1
    else void resource.reload()
  }
  const mutation = useMutation()
  const changing = ref(false),
    password = ref(''),
    confirm = ref('')
  const selected = ref<LoginSession | null>(null)
  const codes = ref<string[]>([]),
    creatingCodes = ref(false),
    loggingOut = ref(false)
  async function recoveryCodes() {
    let received: string[] = []
    if (
      await mutation.run(async () => {
        received = (await accountApi.recoveryCodes()).codes
      })
    ) {
      codes.value = received
      creatingCodes.value = false
    }
  }
  async function logoutAll() {
    if (await mutation.run(accountApi.logoutAll)) sessionController.clear()
  }
  function closePassword(): void {
    changing.value = false
    password.value = ''
    confirm.value = ''
  }
  async function changePassword(): Promise<void> {
    if (password.value.length < 8 || password.value !== confirm.value) {
      mutation.error.value = '密码至少8位且两次输入一致'
      return
    }
    if (await mutation.run(() => authApi.changePassword(password.value))) {
      closePassword()
      // 改密会撤销服务端全部登录；同步清空本地身份，壳层转入重新登录。
      sessionController.clear()
    }
  }
  async function revoke(): Promise<void> {
    const value = selected.value
    if (value && (await mutation.run(() => accountApi.revoke(value.id)))) {
      selected.value = null
      await resource.reload()
    }
  }
  function openPassword(): void {
    mutation.error.value = ''
    changing.value = true
  }
  function requestRevoke(session: LoginSession): void {
    mutation.error.value = ''
    selected.value = session
  }
  onScopeDispose(() => {
    codes.value = []
    closePassword()
  })
  return {
    pageSize,
    page,
    search,
    applySearch,
    resource,
    mutation,
    changing,
    password,
    confirm,
    selected,
    closePassword,
    changePassword,
    revoke,
    openPassword,
    requestRevoke,
    codes,
    creatingCodes,
    loggingOut,
    recoveryCodes,
    logoutAll,
  }
}
