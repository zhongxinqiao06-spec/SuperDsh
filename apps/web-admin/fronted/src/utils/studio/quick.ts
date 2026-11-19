import type {
  QuickCapabilities,
  QuickDraft,
  QuickInputMode,
  QuickModel,
} from '@/types/studio/quick'

export const quickModeLabels: Record<QuickInputMode, string> = {
  reference: '参考生视频',
  image: '图生视频',
  text: '文生视频',
}
/** 默认值只从可用能力挑选；无模型时保留空选择并在生成前明确阻止。 */
export function initialQuickDraft(capabilities: QuickCapabilities): QuickDraft {
  const model =
    capabilities.models.find(
      (item) => item.id === capabilities.defaultConfigurationId,
    ) ?? capabilities.models[0]
  const mode = model?.inputModes.includes('reference')
    ? 'reference'
    : (model?.inputModes[0] ?? 'text')
  return {
    prompt: '',
    inputMode: mode,
    configurationId: model?.id ?? null,
    durationSeconds: model?.durations.includes(5)
      ? 5
      : (model?.durations[0] ?? 5),
    aspect: model?.aspects[0] ?? '16:9',
    resolution: model?.resolutions[0] ?? '720P',
    references: [],
  }
}
/** Vue 草稿是响应式对象，按字段复制避免 structuredClone 无法复制 Proxy。 */
export function copyQuickDraft(draft: QuickDraft): QuickDraft {
  return { ...draft, references: [...draft.references] }
}
/** 模型切换只校正参数，不删除用户参考素材或提示词。 */
export function alignQuickModel(
  draft: QuickDraft,
  model?: QuickModel,
): QuickDraft {
  if (!model) return { ...draft, configurationId: null }
  return {
    ...draft,
    configurationId: model.id,
    durationSeconds: model.durations.includes(draft.durationSeconds)
      ? draft.durationSeconds
      : (model.durations[0] ?? draft.durationSeconds),
    aspect: model.aspects.includes(draft.aspect)
      ? draft.aspect
      : (model.aspects[0] ?? draft.aspect),
    resolution: model.resolutions.includes(draft.resolution)
      ? draft.resolution
      : (model.resolutions[0] ?? draft.resolution),
  }
}
/** 就近提示可操作缺项；最终权限、输入及受理状态仍由服务端预检。 */
export function quickDraftIssue(draft: QuickDraft, model?: QuickModel): string {
  if (!draft.prompt.trim()) return '先描述你想生成的画面、动作或故事。'
  if (!model || !model.inputModes.includes(draft.inputMode))
    return '当前方式没有可用模型，请选择已配置的模型或切换生成方式。'
  if (
    !model.durations.includes(draft.durationSeconds) ||
    !model.aspects.includes(draft.aspect) ||
    !model.resolutions.includes(draft.resolution)
  )
    return '所选参数不在当前模型支持范围内，请重新选择。'
  if (draft.inputMode === 'text' && draft.references.length)
    return '文生视频不使用参考图，请移除参考关联或切换生成方式。'
  if (draft.inputMode !== 'text' && !draft.references.length)
    return '请选择或上传至少一张参考图。'
  if (draft.inputMode === 'image' && draft.references.length !== 1)
    return '图生视频使用单张参考图，请只保留一张。'
  if (draft.references.length > model.maxReferences)
    return `当前模型最多支持 ${model.maxReferences} 张参考图，请移除多余关联。`
  return ''
}
export function quickSignature(title: string, draft: QuickDraft): string {
  return JSON.stringify([title, draft])
}
