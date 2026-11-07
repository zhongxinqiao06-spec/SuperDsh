import { text } from '../http/api-router.ts'
import { json, type Row } from '../infrastructure/database.ts'
import type { KnowledgeSource } from './knowledge-index.ts'

export type AnswerVerification = {
  status: 'pending' | 'no-citations' | 'references-checked' | 'invalid'
  message: string
  messageId?: string
  sourceIds: string[]
  checkedQuotes: number
  issues: string[]
}

type Evidence = KnowledgeSource & { id: string }
const referencePattern = /\b(?:src|evidence)_[a-zA-Z0-9_-]+\b/gu

/** Checks source identity and literal quotations only; it does not attest the answer. */
export function verifyKnowledgeAnswer(
  answer: string,
  evidence: Evidence[],
): AnswerVerification {
  const result: AnswerVerification = {
    status: 'no-citations',
    message: '回答未提供可校验引用，请查阅原文；不能视为已核实的结论。',
    sourceIds: [],
    checkedQuotes: 0,
    issues: [],
  }
  if (answer.length > 100000) {
    return {
      ...result,
      status: 'invalid',
      message: '回答过长，无法完成引用校验。',
      issues: ['引用校验超出长度限制'],
    }
  }
  const sources = new Map<string, Evidence>()
  for (const item of evidence) {
    sources.set(item.id, item)
    sources.set(item.sourceId, item)
  }
  const ids = [...new Set(answer.match(referencePattern) ?? [])]
  if (ids.length > 100) {
    return {
      ...result,
      status: 'invalid',
      message: '回答引用过多，无法完成引用校验。',
      issues: ['引用数量超出限制'],
    }
  }
  result.sourceIds = ids.filter((id) => sources.has(id))
  for (const id of ids) {
    if (!sources.has(id))
      result.issues.push(`引用不存在、已失效或不属于当前会话：${id}`)
  }
  // HTML is never a citation format and is never rendered as trusted evidence.
  if (/<\/?cite\b/iu.test(answer))
    result.issues.push('引用包含不支持的 HTML 标记，请使用“逐字原文”[引用ID]')
  const quotes = answer.matchAll(
    /(?:“([^“”]+)”|「([^「」]+)」|"([^"]+)")\s*\[([a-zA-Z0-9_-]+)\]/gu,
  )
  for (const match of quotes) {
    const quote = match[1] ?? match[2] ?? match[3] ?? ''
    const id = match[4]!
    const source = sources.get(id)
    if (!source) {
      result.issues.push(`摘录引用无效：${id}`)
    } else if (
      !quote.trim() ||
      quote.length > 900 ||
      !source.content.includes(quote)
    ) {
      result.issues.push(`摘录与授权原文不一致：${id}`)
    } else result.checkedQuotes++
  }
  result.issues = [...new Set(result.issues)]
  if (result.issues.length) {
    result.status = 'invalid'
    result.message =
      '回答的引用校验未通过。请以可打开的原文为准，不要将该回答视为已核实。'
  } else if (ids.length) {
    result.status = 'references-checked'
    result.message = `已核对 ${ids.length} 个来源编号及 ${result.checkedQuotes} 处规范格式的逐字摘录；改写、推断及整篇回答尚未核实。`
  }
  return result
}

export function verifyKnowledgeTimelineAnswer(
  row: Row | undefined,
  evidence: Evidence[],
): AnswerVerification {
  if (!row || !['completed', 'done'].includes(text(row.status))) {
    return {
      status: 'pending',
      message: '等待完整回答后校验引用；下方仅展示授权原文。',
      sourceIds: [],
      checkedQuotes: 0,
      issues: [],
      ...(row ? { messageId: text(row.id) } : {}),
    }
  }
  const item =
    row.payload_json && typeof row.payload_json === 'object'
      ? (row.payload_json as Row)
      : json<Row>(row.payload_json, {})
  const content =
    item.content && typeof item.content === 'object'
      ? (item.content as Row)
      : {}
  const answer =
    text(content.text) ||
    text(content.content) ||
    text(content.message) ||
    text(content.rawText)
  return { ...verifyKnowledgeAnswer(answer, evidence), messageId: text(row.id) }
}
