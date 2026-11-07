import { ApiError, object, text } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'

/** A paid, terminal response cannot be repaired by downloading it again. */
export function visionResponse(value: Row): string {
  const reason = text(object(value.incomplete_details ?? {}).reason)
  const choices = Array.isArray(value.choices) ? value.choices : []
  if (
    value.status === 'incomplete' ||
    object(choices[0] ?? {}).finish_reason === 'length'
  )
    throw new ApiError(
      502,
      reason === 'length' || reason === 'max_output_tokens' || choices.length
        ? '视觉分析达到输出上限，未得到完整回答。推理也占用输出额度；请调整深度思考或最大输出配置，重新确认后再调用。'
        : '视觉分析未完整结束，请检查模型配置并重新确认；未自动重试收费调用。',
      { code: 'vision_response_incomplete' },
    )
  if (value.status === 'failed' || value.status === 'cancelled' || value.error)
    throw new ApiError(502, '视觉供应商未完成分析；未自动重试收费调用。')
  const answer = Array.isArray(value.output)
    ? value.output
        .filter((entry) => object(entry).type === 'message')
        .flatMap((entry) =>
          Array.isArray(object(entry).content)
            ? (object(entry).content as unknown[])
            : [],
        )
        .filter((entry) => object(entry).type === 'output_text')
        .map((entry) => text(object(entry).text))
        .filter(Boolean)
        .join('\n')
    : text(object(object(choices[0] ?? {}).message ?? {}).content)
  if (!answer.trim()) throw new ApiError(502, '视觉服务未返回有效正文')
  return answer
}
