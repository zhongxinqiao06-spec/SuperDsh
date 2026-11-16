import { computed, onScopeDispose, ref, watch } from 'vue'
import { recordApi, type PlanRecord } from '@/api/workbench/record-api'
import type { InputForm, QuestionAnswer } from '@/utils/workbench/interaction'
import { errorMessage } from '@/utils/errors'

/** 按问题内的持久收据读取本次审批方案，不以最近一次工具调用推断批准对象。 */
export function useNoticePlans(options: {
  session: () => string | undefined
  form: () => InputForm | null
}) {
  const plans = ref<Record<string, PlanRecord>>({})
  const errors = ref<Record<string, string>>({})
  const loading = ref(false)
  let controller: AbortController | undefined
  const questions = computed(
    () =>
      options
        .form()
        ?.questions.filter(
          (question) =>
            question.approveOptionId && /^call_[a-f0-9]{64}$/.test(question.id),
        ) ?? [],
  )
  async function reload() {
    controller?.abort()
    const abort = new AbortController()
    controller = abort
    plans.value = {}
    errors.value = {}
    const session = options.session()
    if (!questions.value.length) {
      loading.value = false
      return
    }
    if (!session) {
      errors.value = Object.fromEntries(
        questions.value.map((q) => [
          q.id,
          '会话身份暂不可用，请重新打开当前会话。',
        ]),
      )
      loading.value = false
      return
    }
    loading.value = true
    await Promise.all(
      questions.value.map(async (question) => {
        try {
          const { plan } = await recordApi.plan(
            session,
            question.id,
            abort.signal,
          )
          if (abort.signal.aborted) return
          if (plan.id !== question.id || plan.sessionId !== session)
            throw new Error('返回方案与当前审批不匹配，请重新同步。')
          plans.value[question.id] = plan
          if (plan.state !== 'prepared')
            errors.value[question.id] =
              '此方案已不在待确认状态，请同步会话后继续。'
        } catch (cause) {
          if (!abort.signal.aborted)
            errors.value[question.id] = errorMessage(cause)
        }
      }),
    )
    if (!abort.signal.aborted) loading.value = false
  }
  const requiresPlan = (id: string) => questions.value.some((q) => q.id === id)
  const ready = (id: string) =>
    !requiresPlan(id) || plans.value[id]?.state === 'prepared'
  // 看不到持久方案时禁止批准，仍允许用户明确提出修改或取消。
  function canSubmit(answers: Record<string, QuestionAnswer>) {
    return questions.value.every((question) => {
      const answer = answers[question.id]
      return (
        !answer ||
        answer.useCustom ||
        !answer.optionIds.includes(question.approveOptionId!) ||
        ready(question.id)
      )
    })
  }
  watch(
    [() => options.session(), () => questions.value.map((q) => q.id).join(',')],
    reload,
    { immediate: true },
  )
  onScopeDispose(() => controller?.abort())
  return { plans, errors, loading, requiresPlan, ready, canSubmit, reload }
}
