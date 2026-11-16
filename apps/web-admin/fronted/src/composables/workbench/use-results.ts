import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  resultApi,
  type ArtifactView,
  type SkillRunView,
} from '@/api/workbench/result-api'
import { useArtifactActions } from './use-artifact-actions'
import { errorMessage } from '@/utils/errors'

/** 会话成果轮询带取消与代际，旧会话结果不会进入新会话。 */
export function useResults(session: Ref<string>) {
  const runs = ref<SkillRunView[]>([]),
    artifacts = ref<ArtifactView[]>([]),
    error = ref(''),
    loaded = ref(false)
  const actions = useArtifactActions(session)
  let controller = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined,
    generation = 0
  async function reload() {
    const started = generation,
      id = session.value
    if (!id) return
    try {
      const [runData, artifactData] = await Promise.all([
        resultApi.runs(id, controller.signal),
        resultApi.artifacts(id, controller.signal),
      ])
      if (started !== generation) return
      loaded.value = true
      runs.value = runData.items
      artifacts.value = artifactData.items
      error.value = ''
    } catch (cause) {
      if (started === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
    if (started === generation && !controller.signal.aborted)
      timer = setTimeout(() => void reload(), 5000)
  }
  watch(
    session,
    () => {
      generation++
      controller.abort()
      controller = new AbortController()
      if (timer) clearTimeout(timer)
      loaded.value = false
      runs.value = []
      artifacts.value = []
      error.value = ''
      void reload()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation++
    controller.abort()
    if (timer) clearTimeout(timer)
  })
  return {
    ...actions,
    loaded,
    runs,
    artifacts,
    error: computed(() => error.value || actions.error.value),
  }
}
