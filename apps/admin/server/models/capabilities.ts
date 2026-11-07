import type {
  CapabilityDescriptor,
  ModelAdapter,
  ModelCapability,
} from '@superdsh/core/contracts/platform'
import { ApiError, integer, object, text } from '../http/api-router.ts'

const schema = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
})
export const modelCapabilities: CapabilityDescriptor[] = [
  {
    id: 'chat',
    name: '聊天与工具调用',
    available: true,
    inputTypes: ['text', 'image'],
    outputTypes: ['text', 'tool-call'],
    configurationSchema: schema({
      maxTokens: {
        type: 'integer',
        title: '最大输出 Token',
        minimum: 1,
        maximum: 131072,
      },
      contextWindow: {
        type: 'integer',
        title: '上下文窗口 Token（按模型规格填写）',
        minimum: 1024,
        maximum: 10485760,
      },
    }),
    cancellation: 'abort-request',
  },
  {
    id: 'image.generate',
    name: '图片生成与参考图编辑',
    available: true,
    inputTypes: ['text', 'image'],
    outputTypes: ['image'],
    configurationSchema: schema({
      imageProfile: {
        type: 'string',
        title: '图片模型规格',
        enum: ['auto', 'seedream-4', 'seedream-5', 'openai-images'],
        default: 'auto',
      },
      size: { type: 'string', title: '输出尺寸／分辨率', default: '2K' },
      maxImages: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        default: 1,
        title: '最多参考图片数量',
      },
    }),
    cancellation: 'abort-request',
  },
  {
    id: 'vision.analyze',
    name: '视觉理解与页面检查',
    available: true,
    inputTypes: ['text', 'image'],
    outputTypes: ['text'],
    configurationSchema: schema({
      maxTokens: { type: 'integer', minimum: 1, maximum: 16384, default: 4096 },
      maxImages: { type: 'integer', minimum: 1, maximum: 10, default: 4 },
      thinking: {
        type: 'string',
        title: '火山视觉深度思考',
        enum: ['provider-default', 'disabled', 'enabled'],
        default: 'disabled',
        'x-superdsh-adapters': ['volcengine-ark'],
        'x-superdsh-legacy-default': 'provider-default',
      },
    }),
    cancellation: 'abort-request',
  },
  ...(
    [
      'speech.transcribe',
      'speech.synthesize',
      'video.generate',
      'embedding',
    ] as const
  ).map((id) => ({
    id,
    name: {
      'speech.transcribe': '语音识别',
      'speech.synthesize': '语音合成',
      'video.generate': '视频生成',
      embedding: '向量化',
    }[id],
    available: false,
    inputTypes: [],
    outputTypes: [],
    configurationSchema: schema({}),
    cancellation: 'unsupported' as const,
  })),
]
export const modelAdapters: ModelAdapter[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'volcengine-ark',
  'volcengine-speech',
]
export function capability(id: string): CapabilityDescriptor {
  const result = modelCapabilities.find((entry) => entry.id === id)
  if (!result) throw new ApiError(422, '未知模型能力')
  return result
}
export function validateModelParameters(
  adapter: ModelAdapter,
  id: ModelCapability,
  modelId: string,
  input: unknown,
): Record<string, unknown> {
  const values = object(input ?? {})
  const descriptor = capability(id)
  if (!descriptor.available)
    throw new ApiError(422, '此能力尚未接入，暂不能启用')
  if (
    adapter === 'volcengine-speech' ||
    (id !== 'chat' && adapter === 'anthropic-messages')
  )
    throw new ApiError(422, '该连接尚未实现所选能力')
  const allowed = object(descriptor.configurationSchema.properties)
  if (Object.keys(values).some((key) => !(key in allowed)))
    throw new ApiError(422, '包含不允许的模型参数')
  if (id === 'image.generate') {
    const requestedProfile = text(values.imageProfile, 'auto')
    if (
      !['auto', 'seedream-4', 'seedream-5', 'openai-images'].includes(
        requestedProfile,
      )
    )
      throw new ApiError(422, '图片模型规格不受支持')
    const inferred =
      adapter !== 'volcengine-ark'
        ? 'openai-images'
        : /seedream[-.]5/i.test(modelId)
          ? 'seedream-5'
          : /seedream[-.]4/i.test(modelId)
            ? 'seedream-4'
            : 'auto'
    const imageProfile =
      requestedProfile === 'auto' ? inferred : requestedProfile
    if (
      (adapter === 'volcengine-ark') === (imageProfile === 'openai-images') ||
      (inferred !== 'auto' &&
        requestedProfile !== 'auto' &&
        inferred !== requestedProfile)
    )
      throw new ApiError(422, '图片规格与供应商或模型版本不匹配')
    if (!['volcengine-ark', 'openai-completions'].includes(adapter))
      throw new ApiError(422, '当前连接不支持图片生成')
    const size = text(
      values.size,
      adapter === 'volcengine-ark' ? '2K' : '1536x1024',
    )
    if (
      adapter !== 'volcengine-ark' &&
      !['1024x1024', '1536x1024', '1024x1536'].includes(size)
    )
      throw new ApiError(422, '图片尺寸不受支持')
    if (adapter === 'volcengine-ark') {
      const pixels = /^(\d{3,5})x(\d{3,5})$/.exec(size)
      if (!['1K', '1.5K', '2K', '4K'].includes(size) && !pixels)
        throw new ApiError(422, '火山图片尺寸格式不正确')
      if (imageProfile === 'auto' && size !== '2K')
        throw new ApiError(422, '未知接入点只开放兼容的 2K；请先明确模型规格')
      const pro = imageProfile === 'seedream-5'
      if (pro && size === '4K')
        throw new ApiError(422, '所选 Seedream 版本不支持 4K')
      if (pixels) {
        const width = Number(pixels[1]),
          height = Number(pixels[2]),
          area = width * height
        if (
          area < (pro ? 921600 : 3686400) ||
          area > (pro ? 4624220 : 16777216) ||
          width / height < 1 / 16 ||
          width / height > 16
        )
          throw new ApiError(422, '图片像素或宽高比超过模型范围')
      }
      if (!pro && ['1K', '1.5K'].includes(size))
        throw new ApiError(422, '此图片配置使用 2K、4K 或合法像素尺寸')
    }
    return { size, imageProfile, maxImages: integer(values.maxImages, 1, 1, 4) }
  }
  if (values.thinking !== undefined && adapter !== 'volcengine-ark')
    throw new ApiError(422, '当前供应商不支持火山深度思考参数')
  const thinking = text(values.thinking, 'disabled')
  if (!['provider-default', 'disabled', 'enabled'].includes(thinking))
    throw new ApiError(422, '视觉深度思考模式不受支持')
  return {
    ...(id === 'chat' && values.contextWindow !== undefined
      ? { contextWindow: integer(values.contextWindow, 32768, 1024, 10485760) }
      : {}),
    maxTokens: integer(
      values.maxTokens,
      4096,
      1,
      id === 'chat' ? 131072 : 16384,
    ),
    ...(id === 'vision.analyze'
      ? {
          maxImages: integer(values.maxImages, 4, 1, 10),
          ...(adapter === 'volcengine-ark' ? { thinking } : {}),
        }
      : {}),
  }
}
