import type { ModelAdapter, ModelConnection } from '@/types/models/models'

/** 目录和编辑器共用协议显示名，不改变发给服务端的适配器标识。 */
export const adapterNames: Record<ModelAdapter, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'volcengine-ark': '火山方舟',
  'volcengine-speech': '火山语音（能力尚未开放）',
}

/** 登记值优先；未登记时仅显示该上游公开的套餐类型和说明。 */
export function supplierPlan(c: ModelConnection) {
  const url = new URL(c.baseUrl)
  if (url.hostname === 'api.deepseek.com')
    return {
      plan: '按量计费',
      unit: '',
      docs: 'https://api-docs.deepseek.com/api/get-user-balance/',
      note: '余额支持实时查询。',
    }
  if (url.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com')
    return {
      plan: 'Token Plan',
      unit: 'Credits',
      docs: 'https://help.aliyun.com/zh/model-studio/token-plan-usage-quota',
      note: '',
    }
  if (
    url.hostname === 'ark.cn-beijing.volces.com' &&
    url.pathname.startsWith('/api/plan/')
  )
    return {
      plan: 'Agent Plan',
      unit: 'AFP',
      docs: 'https://docs.volcengine.com/docs/ark/get-afp-usage-api?lang=zh',
      note: '官方额度查询使用独立的云账号 Access Key，当前连接使用模型 API Key。',
    }
  return { plan: '未登记套餐', unit: '', docs: '', note: '' }
}
