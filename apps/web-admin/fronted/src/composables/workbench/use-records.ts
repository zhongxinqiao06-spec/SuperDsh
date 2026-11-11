import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  recordApi,
  type PlanRecord,
  type SourceRecord,
  type AnswerVerification,
} from '@/api/workbench/record-api'
import { errorMessage } from '@/utils/errors'

/** 编辑草稿与轮询版本分离；409 保留草稿，切会话立即撤销旧异步结果。 */
export function useRecords(session: Ref<string>) {
  const plans = ref<PlanRecord[]>([]),
    sources = ref<SourceRecord[]>([]),
    verification = ref<AnswerVerification | null>(null),
    editing = ref<PlanRecord | null>(null),
    source = ref<SourceRecord | null>(null),
    draft = ref(''),
    error = ref(''),
    note = ref(''),
    saving = ref(false)
  let generation = 0,
    controller = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined
  async function reload() {
    const current = generation,
      id = session.value
    if (!id) return
    try {
      const [plan, evidence] = await Promise.all([
        recordApi.plans(id, controller.signal),
        recordApi.evidence(id, controller.signal),
      ])
      if (current !== generation) return
      plans.value = plan.items
      sources.value = evidence.items
      verification.value = evidence.answerVerification
    } catch (cause) {
      if (current === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
    if (current === generation && !controller.signal.aborted)
      timer = setTimeout(() => void reload(), 7000)
  }
  function edit(plan: PlanRecord) {
    editing.value = plan
    draft.value = JSON.stringify(plan.document, null, 2)
    error.value = ''
    note.value = ''
  }
  async function save() {
    const plan = editing.value,
      current = generation
    if (!plan || saving.value) return
    saving.value = true
    error.value = ''
    try {
      const document: unknown = JSON.parse(draft.value)
      if (!document || typeof document !== 'object' || Array.isArray(document))
        throw new Error('方案必须是 JSON 对象')
      const result = await recordApi.revise(
        session.value,
        plan,
        document as Record<string, unknown>,
      )
      if (current !== generation) return
      editing.value = null
      note.value = result.note
      plans.value = plans.value.map((item) =>
        item.id === result.plan.id ? result.plan : item,
      )
    } catch (cause) {
      if (current === generation) error.value = errorMessage(cause)
    } finally {
      if (current === generation) saving.value = false
    }
  }
  async function readSource(id: string) {
    const current = generation
    try {
      const value = await recordApi.source(session.value, id, controller.signal)
      if (current === generation) source.value = value.source
    } catch (cause) {
      if (current === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
  }
  watch(
    session,
    () => {
      generation++
      controller.abort()
      controller = new AbortController()
      if (timer) clearTimeout(timer)
      plans.value = []
      sources.value = []
      verification.value = null
      editing.value = null
      source.value = null
      draft.value = ''
      error.value = ''
      note.value = ''
      saving.value = false
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
    plans,
    sources,
    verification,
    editing,
    source,
    draft,
    error,
    note,
    saving,
    edit,
    save,
    readSource,
  }
}
