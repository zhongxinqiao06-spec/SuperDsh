import { computed, reactive, ref, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { accessApi } from '@/api/access/access-api'
import type { PlatformRole, RoleDraft } from '@/types/access/access'

/** 角色目录采用前端分页，保存/删除始终走真实授权API。 */
export function useRoles() {
  const resource = useResource(accessApi.roles)
  const mutation = useMutation()
  const editing = ref<PlatformRole | 'new' | null>(null)
  const deleting = ref<PlatformRole | null>(null)
  const search = ref(''),
    page = ref(1),
    pageSize = ref(10)
  const readonly = computed(
    () => editing.value !== 'new' && !!editing.value?.builtin,
  )
  const draft = reactive<RoleDraft>({
    name: '',
    description: '',
    permissions: [],
  })
  const filtered = computed(() =>
    (resource.data.value?.roles ?? []).filter((role) =>
      `${role.name} ${role.description}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ),
  )
  const rows = computed(() =>
    filtered.value.slice(
      (page.value - 1) * pageSize.value,
      page.value * pageSize.value,
    ),
  )
  // 删除最后一页的记录或调整页大小后，回到仍然存在的页，避免空页误导。
  watch([() => filtered.value.length, pageSize], ([count, size]) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(count / size)))
  })
  function edit(role: PlatformRole | 'new'): void {
    editing.value = role
    mutation.error.value = ''
    Object.assign(
      draft,
      role === 'new'
        ? { name: '', description: '', permissions: [] }
        : {
            name: role.name,
            description: role.description,
            permissions: [...role.permissions],
          },
    )
  }
  async function save(): Promise<void> {
    if (readonly.value) return
    if (!editing.value || !draft.name.trim()) {
      mutation.error.value = '请填写角色名称'
      return
    }
    const role = editing.value === 'new' ? null : editing.value
    if (
      await mutation.run(() =>
        accessApi.saveRole(role, { ...draft, name: draft.name.trim() }),
      )
    ) {
      editing.value = null
      await resource.reload()
    }
  }
  async function remove(): Promise<void> {
    const role = deleting.value
    if (role && (await mutation.run(() => accessApi.deleteRole(role)))) {
      deleting.value = null
      await resource.reload()
    }
  }
  function requestDelete(role: PlatformRole): void {
    if (role.builtin) return
    mutation.error.value = ''
    deleting.value = role
  }
  return {
    readonly,
    resource,
    mutation,
    editing,
    deleting,
    search,
    page,
    pageSize,
    draft,
    filtered,
    rows,
    edit,
    save,
    remove,
    requestDelete,
  }
}
