import { ApiError, object, requiredText, text } from '../http/api-router.ts'
import { providerRequest } from '../models/provider-http.ts'
import { imageData } from '../agents/office/image-data.ts'

export async function imageToolWork(
  operation: 'inspect' | 'prepare' | 'generate',
  document: unknown,
  configuration: Record<string, unknown>,
  allowedOrigins: string,
  signal: AbortSignal,
) {
  if (operation === 'inspect')
    return {
      configured: true,
      sizes: ['1024x1024', '1536x1024', '1024x1536'],
      note: '请先确认配图用途、提示词和数量。精确文字、公司标识和数据图表应保持原生可编辑。',
    }
  const input = object(document)
  const title = requiredText(input.title, '配图标题', 100)
  const prompt = requiredText(input.prompt, '生图提示词', 12000)
  const size = text(input.size || configuration.size, '1536x1024')
  if (!['1024x1024', '1536x1024', '1024x1536'].includes(size))
    throw new ApiError(422, '生图尺寸不受支持')
  const plan = {
    title,
    prompt,
    size,
    purpose: text(input.purpose).slice(0, 500),
    imageCount: 1,
  }
  if (operation === 'prepare')
    return {
      document: plan,
      preflight: {
        diagnostics: [
          '将调用已配置生图服务生成 1 张图片，可能产生额外费用；失败不会自动切换供应商。',
        ],
      },
    }
  const apiKey = text(configuration.apiKey)
  if (!apiKey)
    throw new ApiError(
      422,
      '生图工具尚未配置 API Key，请配置后重试、上传图片或采用无生图方案',
    )
  const base = requiredText(
    configuration.baseUrl,
    '生图服务地址',
    2048,
  ).replace(/\/+$/u, '')
  const url = base.endsWith('/images/generations')
    ? base
    : base + '/images/generations'
  const timeout = AbortSignal.timeout(240000)
  const combined = AbortSignal.any([signal, timeout])
  let response: Awaited<ReturnType<typeof providerRequest>> | undefined
  try {
    response = await providerRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json',
      },
      body: Buffer.from(
        JSON.stringify({
          model: requiredText(configuration.model, '生图模型', 200),
          prompt,
          size,
          n: 1,
          ...(configuration.responseFormat === 'b64_json'
            ? { response_format: 'b64_json' }
            : {}),
        }),
      ),
      personal: true,
      allowedOrigins,
      signal: combined,
    })
    const parts: Buffer[] = []
    let length = 0
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      if (length > 32 * 1024 * 1024)
        throw new ApiError(413, '生图响应超过大小限制')
      parts.push(bytes)
    }
    if ((response.statusCode ?? 500) >= 300)
      throw new ApiError(
        502,
        '生图供应商拒绝了请求（HTTP ' +
          response.statusCode +
          '），请检查模型、余额和配置；尚未更换费用来源',
      )
    let value: Record<string, unknown>
    try {
      value = object(JSON.parse(Buffer.concat(parts).toString('utf8')))
    } catch {
      throw new ApiError(502, '生图服务未返回有效的 JSON')
    }
    const data = Array.isArray(value.data) ? value.data[0] : undefined
    const encoded = text(object(data ?? {}).b64_json)
    if (!encoded)
      throw new ApiError(
        502,
        '生图服务未返回 base64 图片，请配置兼容响应格式后重试',
      )
    const content = Buffer.from(encoded, 'base64')
    if (content.toString('base64') !== encoded)
      throw new ApiError(502, '生图服务返回的图片编码无效')
    const filename = title.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '_') + '.png'
    imageData({ filename, content })
    return {
      content,
      filename,
      mediaType: 'image/png',
      summary: {
        purpose: plan.purpose,
        prompt,
        model: text(configuration.model),
        imageCount: 1,
        source: 'configured-image-provider',
      },
      diagnostics: [
        {
          code: 'generated-illustration',
          message:
            'AI 生成配图，未进行视觉模型审查；请核对内容后用于正式文件。',
        },
      ],
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted)
      throw new ApiError(504, '生图服务超时，未自动重试收费调用')
    throw error
  } finally {
    response?.destroy()
  }
}
