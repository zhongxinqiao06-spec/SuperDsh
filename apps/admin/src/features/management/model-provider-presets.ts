import type { ProviderWrite } from './models-api'

export type ModelProviderPreset = 'deepseek' | 'custom'

export function createProviderDraft(
  preset: ModelProviderPreset = 'deepseek',
): ProviderWrite {
  if (preset === 'custom') {
    return {
      name: '',
      protocol: 'openai-completions',
      baseUrl: '',
      enabled: true,
      models: [{ modelId: '', name: '', inputTypes: ['text'] }],
    }
  }

  // Official API model IDs: https://api-docs.deepseek.com/quick_start/pricing/
  // Keep credentials out of presets; the user supplies their own key.
  return {
    name: 'DeepSeek',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    enabled: true,
    models: [
      {
        modelId: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        inputTypes: ['text', 'image'],
      },
      {
        modelId: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        inputTypes: ['text'],
      },
    ],
  }
}
