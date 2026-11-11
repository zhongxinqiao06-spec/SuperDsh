import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  agentBindingApi,
  type SessionAgentBinding,
} from '@/api/workbench/agent-binding-api'
import { sessionController } from '@/store/session-controller'
import { errorMessage } from '@/utils/errors'

/** 绑定切换先确认后提交 CAS；迟到结果不得写入已切换的会话或账号。 */
export function useAgentBinding(
  sessionId: Ref<string>,
  canEdit: Ref<boolean>,
  refresh: () => Promise<void>,
) {
  const binding = ref<SessionAgentBinding | null>(null),
    loading = ref(false),
    saving = ref(false),
    error = ref('')
  let controller: AbortController | null = null
  let alive = true,
    sequence = 0
  async function load(): Promise<void> {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal,
      id = sessionId.value,
      identity = sessionController.generation,
      current = ++sequence
    binding.value = null
    error.value = ''
    if (!id) return
    loading.value = true
    try {
      const value = await agentBindingApi.get(id, signal)
      if (
        alive &&
        current === sequence &&
        identity === sessionController.generation
      )
        binding.value = value
    } catch (cause) {
      if (alive && !signal.aborted && current === sequence)
        error.value = errorMessage(cause)
    } finally {
      if (current === sequence) loading.value = false
    }
  }
  async function change(value: string): Promise<void> {
    const prior = binding.value,
      id = sessionId.value,
      identity = sessionController.generation
    if (
      !prior ||
      !value ||
      !canEdit.value ||
      saving.value ||
      (prior.agentDefinition?.id ?? '') === value
    )
      return
    saving.value = true
    error.value = ''
    try {
      await ElMessageBox.confirm(
        '切换后后续任务使用所选智能体的冻结配置，已有消息和成果保留。',
        '切换智能体',
        { confirmButtonText: '确认切换', cancelButtonText: '取消' },
      )
      if (
        !alive ||
        id !== sessionId.value ||
        identity !== sessionController.generation ||
        !canEdit.value
      )
        return
      const result = await agentBindingApi.update(
        id,
        value,
        prior.bindingVersion,
      )
      if (
        !alive ||
        id !== sessionId.value ||
        identity !== sessionController.generation
      )
        return
      binding.value = result
      await refresh()
    } catch (cause) {
      if (
        cause !== 'cancel' &&
        cause !== 'close' &&
        alive &&
        id === sessionId.value &&
        identity === sessionController.generation
      )
        error.value = errorMessage(cause)
    } finally {
      saving.value = false
    }
  }
  watch(
    sessionId,
    () => {
      void load()
    },
    { immediate: true },
  )
  const unsubscribe = sessionController.subscribe(() => {
    if (!sessionController.current) {
      sequence++
      controller?.abort()
      binding.value = null
      error.value = ''
    }
  })
  onScopeDispose(() => {
    alive = false
    sequence++
    controller?.abort()
    unsubscribe()
  })
  return {
    binding,
    current: computed(() => binding.value?.agentDefinition?.id ?? ''),
    loading,
    saving,
    error,
    change,
    reload: load,
  }
}
