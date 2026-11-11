import { computed, reactive, ref, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { accessApi } from '@/api/access/access-api'
import type { ManagedUser, UserAction, UserDraft } from '@/types/access/access'

const blank = (): UserDraft => ({
  username: '',
  email: '',
  displayName: '',
  password: '',
  roles: ['member'],
})

/** 用户列表与编辑用例；权限、分页和失败草稿独立于展示组件。 */
export function useUsers() {
  const auth = useAuthStore()
  const page = ref(1),
    pageSize = ref(10),
    query = ref(''),
    search = ref('')
  const resource = useResource((signal) =>
    accessApi.users(page.value, search.value, pageSize.value, signal),
  )
  const roleResource = useResource(async (signal) =>
    auth.can('roles.manage')
      ? accessApi.roles(signal)
      : { roles: [], permissions: [] },
  )
  const mutation = useMutation()
  const notice = ref('')
  const editing = ref<ManagedUser | 'new' | null>(null)
  const draft = reactive(blank())
  const confirmation = ref<{
    user: ManagedUser
    action: UserAction
  } | null>(null)
  const editable = computed(() => auth.can('users.manage'))
  watch([page, pageSize, search], () => {
    void resource.reload()
  })
  watch(resource.data, (data) => {
    if (data && page.value > 1) {
      page.value = Math.min(
        page.value,
        Math.max(1, Math.ceil(data.total / pageSize.value)),
      )
    }
  })
  function filter(): void {
    page.value = 1
    search.value = query.value.trim()
    void resource.reload()
  }
  function edit(user: ManagedUser | 'new'): void {
    editing.value = user
    mutation.error.value = ''
    Object.assign(
      draft,
      user === 'new'
        ? blank()
        : {
            username: user.username ?? '',
            email: user.email ?? '',
            displayName: user.displayName,
            password: '',
            roles: [...(user.roles ?? [user.role])],
          },
    )
  }
  async function save(): Promise<void> {
    const user = editing.value
    if (!user) return
    if (
      !draft.displayName.trim() ||
      (user === 'new' && (!draft.username.trim() || draft.password.length < 8))
    ) {
      mutation.error.value = '请填写显示名称、用户名及至少8位密码'
      return
    }
    const success = await mutation.run(() =>
      user === 'new'
        ? accessApi.createUser({
            ...draft,
            username: draft.username.trim(),
            displayName: draft.displayName.trim(),
          })
        : accessApi.updateUser(user, {
            displayName: draft.displayName.trim(),
            ...(auth.can('roles.manage') && user.userId !== auth.session?.userId
              ? { roles: draft.roles }
              : {}),
          }),
    )
    if (success) {
      editing.value = null
      Object.assign(draft, blank())
      await resource.reload()
    }
  }
  async function confirm(): Promise<void> {
    const value = confirmation.value
    if (!value) return
    const success = await mutation.run(() => {
      if (value.action === 'delete') return accessApi.deleteUser(value.user)
      if (value.action === 'restore') return accessApi.restoreUser(value.user)
      if (value.action === 'reset')
        return accessApi.requestPasswordRecovery(value.user)
      return accessApi.updateUser(value.user, {
        disabled: value.action === 'disable',
      })
    })
    if (success) {
      confirmation.value = null
      if (value.action === 'reset')
        notice.value =
          '请用户在登录页用自己的恢复码重置密码。管理员无法设置他人的新密码。'
      await resource.reload()
    }
  }
  function requestConfirmation(user: ManagedUser, action: UserAction): void {
    mutation.error.value = ''
    confirmation.value = { user, action }
  }
  return {
    notice,
    page,
    pageSize,
    query,
    resource,
    roleResource,
    mutation,
    editing,
    draft,
    confirmation,
    editable,
    filter,
    edit,
    save,
    confirm,
    requestConfirmation,
    auth,
  }
}
