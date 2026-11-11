import { objectValue } from './timeline'
import type { RuntimeNotice } from '@/types/workbench/models'

export interface InputQuestion {
  id: string
  prompt: string
  detail: string
  multiple: boolean
  allowCustom: boolean
  options: { id: string; label: string; description: string }[]
}
export interface InputForm {
  actionId: string
  questions: InputQuestion[]
}
export interface QuestionAnswer {
  optionIds: string[]
  customText: string
  useCustom: boolean
}

/** 仅解析明确的 inputRequest 展示合同，不执行 Schema 中的脚本或 HTML。 */
export function inputForm(notice: RuntimeNotice): InputForm | null {
  const actions = Array.isArray(notice.actions)
    ? notice.actions.map(objectValue)
    : []
  for (const action of actions) {
    const schema = objectValue(objectValue(action.input).uiSchema)
    if (schema.component !== 'inputRequest' || !Array.isArray(schema.questions))
      continue
    const questions: InputQuestion[] = []
    const seen = new Set<string>()
    for (const raw of schema.questions) {
      const value = objectValue(raw)
      if (
        typeof value.id !== 'string' ||
        typeof value.prompt !== 'string' ||
        seen.has(value.id) ||
        !Array.isArray(value.options)
      )
        return null
      seen.add(value.id)
      const options = value.options.map(objectValue)
      if (
        options.some(
          (option) =>
            typeof option.id !== 'string' || typeof option.label !== 'string',
        )
      )
        return null
      questions.push({
        id: value.id,
        prompt: value.prompt,
        detail: String(value.detail ?? ''),
        multiple: value.multiple === true,
        allowCustom: value.allowCustom !== false,
        options: options.map((option) => ({
          id: String(option.id),
          label: String(option.label),
          description: String(option.description ?? ''),
        })),
      })
    }
    const actionId = action.actionId ?? action.id
    return questions.length && typeof actionId === 'string'
      ? { actionId, questions }
      : null
  }
  return null
}

/** 所有必答问题有明确选择或自定义内容后才允许提交，空白不能默认批准。 */
export function answersComplete(
  form: InputForm | null,
  answers: Record<string, QuestionAnswer>,
): boolean {
  return (
    !!form &&
    form.questions.every((question) => {
      const answer = answers[question.id]
      return (
        answer &&
        (answer.useCustom
          ? question.allowCustom && !!answer.customText.trim()
          : answer.optionIds.length > 0 &&
            new Set(answer.optionIds).size === answer.optionIds.length &&
            answer.optionIds.every((id) =>
              question.options.some((option) => option.id === id),
            ) &&
            (question.multiple || answer.optionIds.length === 1))
      )
    })
  )
}
