import { computed, onScopeDispose, ref } from 'vue'
import { seriesApi } from '@/api/studio/series-api'
import { studioApi } from '@/api/studio/studio-api'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import type { SeriesBrief, StudioSeries } from '@/types/studio/series'
import { errorMessage } from '@/utils/errors'
import { projectBrief } from '@/utils/studio/foundation'
import { createUuid } from '@/utils/uuid'

/** 每次打开新建弹窗独立保存草稿；相同输入失败后重试沿用请求号，不自动生成媒体。 */
export function useSeriesCreation() {
  const auth = useAuthStore()
  const mutation = useMutation()
  const form = ref<SeriesBrief>({
    ...projectBrief(),
    targetDurationMs: 45000,
    narrativeMode: 'continuous',
    plannedEpisodes: 6,
  })
  const baseline = ref(JSON.stringify(form.value))
  const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
  const canCreate = computed(() => auth.can('studio.projects.write'))
  const abort = new AbortController()
  let attempt = { signature: '', key: '' }

  void studioApi
    .creationDefaults(abort.signal)
    .then((defaults) => {
      if (!abort.signal.aborted && !dirty.value) {
        // 默认配置含工程时间基准，整剧表单只采集公开规格字段。
        form.value = {
          ...form.value,
          ...projectBrief({ ...form.value, ...defaults }),
          targetDurationMs: 45000,
        }
        baseline.value = JSON.stringify(form.value)
      }
    })
    .catch((error: unknown) => {
      if (!abort.signal.aborted) mutation.error.value = errorMessage(error)
    })

  async function create(): Promise<StudioSeries | null> {
    if (!canCreate.value || !form.value.title.trim() || mutation.busy.value)
      return null
    let result: StudioSeries | null = null
    const completed = await mutation.run(async () => {
      const snapshot = { ...form.value }
      const signature = JSON.stringify(snapshot)
      if (attempt.signature !== signature)
        attempt = { signature, key: createUuid() }
      result = await seriesApi.create({
        ...snapshot,
        requestKey: attempt.key,
        createEpisodeDrafts: true,
      })
    })
    // 卸载或换号后的返回值不能关闭新弹窗，也不能跳入旧账号的工程。
    if (!completed || !result) return null
    baseline.value = JSON.stringify(form.value)
    return result
  }

  onScopeDispose(() => abort.abort())
  return { form, dirty, canCreate, mutation, create }
}
