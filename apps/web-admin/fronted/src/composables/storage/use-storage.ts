import { reactive, ref, watch } from 'vue'
import { storageApi } from '@/api/storage/storage-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  connectionDraft,
  connectionInput,
} from '@/utils/storage/storage-drafts'
import type {
  ConnectionDraft,
  StorageConnection,
  StorageSettings,
} from '@/types/storage/storage'

/** 连接和策略独立修订；保存失败保留草稿，检查/清理都有可见收据。 */
export function useStorage() {
  const auth = useAuthStore(),
    mutation = useMutation(),
    notice = ref('')
  const resource = useResource(async (signal) => {
    const [settings, usage, migrations] = await Promise.all([
      storageApi.settings(signal),
      storageApi.usage(signal),
      storageApi.migrations(signal),
    ])
    return { settings, usage, migrations }
  })
  const editing = ref<StorageConnection | 'new' | null>(null),
    draft = reactive(connectionDraft()),
    policy = ref<StorageSettings | null>(null),
    cleaning = ref(false)
  const page = ref(1),
    pageSize = ref(10)
  watch(
    () => auth.generation,
    () => {
      editing.value = null
      policy.value = null
      cleaning.value = false
      notice.value = ''
      Object.assign(draft, connectionDraft())
    },
  )
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateDraft(value: ConnectionDraft): void {
    Object.assign(draft, value)
  }
  function edit(value: StorageConnection | 'new'): void {
    editing.value = value
    Object.assign(draft, connectionDraft(value === 'new' ? undefined : value))
    mutation.error.value = ''
  }
  function editPolicy(): void {
    const value = resource.data.value?.settings
    if (value)
      policy.value = {
        ...value,
        policy: { ...value.policy },
        connections: [...value.connections],
      }
    mutation.error.value = ''
  }
  async function save(): Promise<void> {
    const value = editing.value
    if (!value) return
    if (
      await mutation.run(() =>
        storageApi.saveConnection(
          connectionInput(draft, value === 'new' ? undefined : value.revision),
          value === 'new' ? undefined : value.id,
        ),
      )
    ) {
      editing.value = null
      Object.assign(draft, connectionDraft())
      await resource.reload()
    }
  }
  async function savePolicy(): Promise<void> {
    const value = policy.value
    if (!value) return
    if (
      await mutation.run(() =>
        storageApi.saveSettings({
          activeConnectionId: value.activeConnectionId,
          revision: value.revision,
          policy: { ...value.policy },
        }),
      )
    ) {
      policy.value = null
      await resource.reload()
    }
  }
  async function check(value: StorageConnection): Promise<void> {
    notice.value = ''
    if (await mutation.run(() => storageApi.check(value.id)))
      notice.value = `${value.name}：存储连接检查通过`
  }
  async function cleanup(): Promise<void> {
    let removed = 0,
      pending = 0
    if (
      await mutation.run(async () => {
        const result = await storageApi.cleanup()
        removed = result.removed
        pending = result.pending
      })
    ) {
      cleaning.value = false
      notice.value = `已清理 ${removed} 个过期且无引用的文件${pending ? `；${pending} 个对象等待存储恢复后重试清理` : ''}`
      await resource.reload()
    }
  }
  return {
    updateDraft,
    resource,
    mutation,
    notice,
    editing,
    draft,
    policy,
    cleaning,
    page,
    pageSize,
    edit,
    editPolicy,
    save,
    savePolicy,
    check,
    cleanup,
  }
}
