import { providerDraft } from './model-drafts'
import type { ProviderDraft } from '@/types/models/models'

/** 供应商模板属于外部模型元数据，不含密钥，也不决定平台运行时默认配置。 */
export type ProviderPreset = 'deepseek' | 'custom'

/** 保留旧管理端的创建模板；用户可切换自定义并逐项编辑模型。 */
export function providerPresetDraft(preset: ProviderPreset): ProviderDraft {
  const draft = providerDraft()
  if (preset === 'custom') return draft
  return {
    ...draft,
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      {
        modelId: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: null,
        maxTokens: null,
        inputTypes: ['text', 'image'],
      },
      {
        modelId: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: null,
        maxTokens: null,
        inputTypes: ['text'],
      },
    ],
  }
}

/** 模型行先做可定位校验，空白名称回退到ID由保存用例统一规范化。 */
export function providerModelError(
  draft: ProviderDraft,
): { index: number; message: string } | null {
  if (!draft.models.length) return { index: 0, message: '至少添加一个模型。' }
  const ids = new Set<string>()
  for (const [index, model] of draft.models.entries()) {
    const id = model.modelId.trim()
    if (!id) return { index, message: 'Model ID 不能为空。' }
    if (ids.has(id)) return { index, message: `Model ID「${id}」重复。` }
    ids.add(id)
    for (const [label, value] of [
      ['上下文上限', model.contextWindow],
      ['最大输出', model.maxTokens],
    ] as const) {
      if (value !== null && (!Number.isInteger(value) || value <= 0))
        return { index, message: `${label}必须是正整数。` }
    }
  }
  return null
}
