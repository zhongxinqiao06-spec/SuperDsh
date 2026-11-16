import { ref, watch, type Ref } from 'vue'
import { preparationApi } from '@/api/studio/preparation-api'
import type { PreparationState } from '@/types/studio/preparation'
import type { StudioProject } from '@/types/studio/studio'
import { ApiError } from '@/utils/errors'

/** 切换作品和修订时取消旧检查，任务结果变化也会刷新准备清单。 */
export function useStudioPreparation(project: Ref<StudioProject | undefined>) {
  const state = ref<PreparationState>()
  const error = ref('')
  const refreshKey = ref(0)
  watch(
    () => [
      project.value?.id,
      project.value?.revision,
      project.value?.jobs.map((j) => j.id + j.state).join(','),
      refreshKey.value,
    ],
    async (_, __, onCleanup) => {
      if (!project.value) return
      const controller = new AbortController()
      let retry: ReturnType<typeof setTimeout> | undefined
      onCleanup(() => {
        controller.abort()
        clearTimeout(retry)
      })
      try {
        const result = await preparationApi.state(
          project.value.id,
          controller.signal,
        )
        if (!Array.isArray(result.stages))
          throw new Error('阶段检查响应格式异常，请确认前后端已同步更新')
        if (!controller.signal.aborted) {
          state.value = result
          error.value = ''
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          error.value = cause instanceof Error ? cause.message : String(cause)
          // 检查是只读操作，连接恢复后自动重取；权限和业务校验错误等待用户处理。
          if (
            cause instanceof ApiError &&
            (cause.status === 0 || cause.status >= 500)
          )
            retry = setTimeout(() => refreshKey.value++, 4500)
        }
      }
    },
    { immediate: true },
  )
  return { state, error, refresh: () => refreshKey.value++ }
}
