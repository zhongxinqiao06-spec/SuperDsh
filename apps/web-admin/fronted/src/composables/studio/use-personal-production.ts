import { computed, onScopeDispose, ref } from 'vue'
import { productionApi } from '@/api/studio/production-api'
import { studioApi } from '@/api/studio/studio-api'
import { useProductionPlan } from './use-production-plan'
import { useMutation } from '@/composables/use-mutation'
import type { StudioCatalog } from '@/types/studio/studio'
import type {
  PersonalIntent,
  PersonalProduction,
} from '@/types/studio/production'

/** 个人库生成只刷新本设定，轮询离开即取消，不把生成结果自动采用到作品。 */
export function usePersonalProduction(entity: string, updated: () => void) {
  const state = ref<PersonalProduction>(),
    catalog = ref<StudioCatalog>()
  const mutation = useMutation()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    const result = await productionApi.personal(entity, controller.signal)
    if (!controller.signal.aborted) state.value = result
  }
  async function poll() {
    if (controller.signal.aborted) return
    if (!mutation.busy.value) await mutation.run(refresh)
    if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3500)
  }
  void mutation
    .run(async () => {
      catalog.value = await studioApi.catalog()
      await refresh()
    })
    .then(() => {
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 3500)
    })
  onScopeDispose(() => {
    controller.abort()
    clearTimeout(timer)
  })
  const flow = useProductionPlan('entities', () => entity, refresh)
  const allowDuplicate = ref(false),
    reason = ref('')
  const kind = ref<PersonalIntent['kind']>('reference'),
    configuration = ref(''),
    voice = ref(''),
    text = ref('你好，我们一起出发吧。'),
    prompt = ref(''),
    useReference = ref(true)
  const models = computed(() =>
    (catalog.value?.configurations ?? []).filter(
      (m) =>
        m.capability ===
        (kind.value === 'voice' ? 'speech.synthesize' : 'image.generate'),
    ),
  )
  const voices = computed(() => {
    const selected =
      models.value.find((m) => m.id === configuration.value) ??
      models.value.find((m) =>
        catalog.value?.defaults.some(
          (d) =>
            d.capability === 'speech.synthesize' && d.configurationId === m.id,
        ),
      )
    return String(selected?.parameters.voices ?? '')
      .split(',')
      .filter(Boolean)
  })
  async function prepare() {
    if (!state.value) return
    await flow.prepare(() =>
      productionApi.personalPrepare(entity, {
        revision: state.value!.revision,
        requestKey: crypto.randomUUID(),
        kind: kind.value,
        configuration: configuration.value || undefined,
        prompt: prompt.value,
        text: text.value,
        voice: voice.value || state.value!.asset.voice,
        useReference: useReference.value,
        allowDuplicate: allowDuplicate.value,
        reason: reason.value,
      }),
    )
  }
  const adoptKeys = new Map<string, string>()
  async function adopt(job: string) {
    if (!state.value) return
    const key = job + ':' + state.value.revision
    if (!adoptKeys.has(key)) adoptKeys.set(key, crypto.randomUUID())
    await mutation.run(async () => {
      await productionApi.adopt(
        entity,
        state.value!.revision,
        job,
        adoptKeys.get(key)!,
      )
      await refresh()
      updated()
    })
  }
  return {
    allowDuplicate,
    reason,
    state,
    mutation,
    flow,
    kind,
    configuration,
    voice,
    text,
    prompt,
    useReference,
    models,
    voices,
    prepare,
    adopt,
    refresh,
  }
}
