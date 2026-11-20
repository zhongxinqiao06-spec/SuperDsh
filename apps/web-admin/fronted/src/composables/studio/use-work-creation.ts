import { computed, ref, watch } from 'vue'
import { seriesApi } from '@/api/studio/series-api'
import { studioApi } from '@/api/studio/studio-api'
import { useMutation } from '@/composables/use-mutation'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import type { SeriesBrief } from '@/types/studio/series'
import { initialBrief, projectBrief } from '@/utils/studio/foundation'
import { createUuid } from '@/utils/uuid'

/** 创建页独占草稿；只在确认时按模式提交，同一份输入失败重试沿用请求号。 */
export function useWorkCreation(mode: 'storyboard' | 'series') {
  const auth = useAuthStore()
  const mutation = useMutation()
  const defaults = useResource(studioApi.creationDefaults)
  const form = ref<SeriesBrief>({
    ...projectBrief(),
    narrativeMode: 'continuous',
    plannedEpisodes: 6,
  })
  const baseline = ref(JSON.stringify(form.value))
  const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
  const canCreate = computed(() => auth.can('studio.projects.write'))
  let attempt = { signature: '', key: '' }

  watch(
    defaults.data,
    (value) => {
      if (!value || dirty.value) return
      Object.assign(form.value, initialBrief(value))
      if (mode === 'series') form.value.targetDurationMs = 45000
      baseline.value = JSON.stringify(form.value)
    },
    { flush: 'sync' },
  )

  async function create(): Promise<string | null> {
    if (!canCreate.value || !defaults.data.value || mutation.busy.value)
      return null
    const snapshot = { ...form.value }
    if (!snapshot.title.trim()) {
      mutation.error.value = '请填写作品名称。'
      return null
    }
    let id = ''
    const completed = await mutation.run(async () => {
      const signature = JSON.stringify(snapshot)
      if (signature !== attempt.signature)
        attempt = { signature, key: createUuid() }
      const result =
        mode === 'series'
          ? await seriesApi.create({
              ...snapshot,
              requestKey: attempt.key,
              createEpisodeDrafts: true,
            })
          : await studioApi.create({
              ...projectBrief(snapshot),
              requestKey: attempt.key,
            })
      id = result.id
    })
    if (!completed) return null
    baseline.value = JSON.stringify(snapshot)
    return id
  }
  return { form, defaults, dirty, canCreate, mutation, create }
}
