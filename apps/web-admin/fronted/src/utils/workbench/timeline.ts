import type {
  SessionEvent,
  SessionSnapshot,
  TimelineItem,
} from '@/types/workbench/models'
import runtimeContract from '../../../../contracts/dsh-runtime.json'

/** 时间线按身份与修订合并；迟到快照和重复通知不能覆盖新内容。 */
export function mergeTimeline(
  current: TimelineItem[],
  incoming: TimelineItem[],
): TimelineItem[] {
  const values = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    const previous = values.get(item.id)
    if (!previous || (item.revision ?? 1) >= (previous.revision ?? 1))
      values.set(item.id, item)
  }
  return [...values.values()].sort(
    (a, b) => (a.orderSeq ?? 0) - (b.orderSeq ?? 0) || a.id.localeCompare(b.id),
  )
}

/** 最新页刷新保留已经展开的历史；迟到 HTTP 响应不能倒退实时游标。 */
export function mergeSessionSnapshot(
  current: SessionSnapshot | null,
  incoming: SessionSnapshot,
): SessionSnapshot {
  if (!current || current.session.id !== incoming.session.id) return incoming
  const cursor = (value: string) =>
    /^seq:\d+$/.test(value) ? Number(value.slice(4)) : -1
  if (cursor(incoming.eventCursor) < cursor(current.eventCursor)) return current
  const first = incoming.timeline.items[0]?.orderSeq
  if (!incoming.timeline.hasMore || first === undefined) return incoming
  const knownIds = new Set(current.timeline.items.map((item) => item.id))
  // 长断线后的新窗口完全无交集时保留服务端分页游标，避免把中间缺口当已加载历史。
  if (!incoming.timeline.items.some((item) => knownIds.has(item.id)))
    return incoming
  const history = current.timeline.items.filter(
    (item) => item.orderSeq !== undefined && item.orderSeq < first,
  )
  if (!history.length) return incoming
  return {
    ...incoming,
    timeline: {
      items: mergeTimeline(history, incoming.timeline.items),
      nextSeq: incoming.timeline.nextSeq,
      hasMore: current.timeline.hasMore,
    },
  }
}

/** 协议对象收敛只用于展示，严禁将服务返回字符串当 HTML 执行。 */
export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 提取不同来源消息块的正文，保留工具结果可折叠检查。 */
export function messageText(item: TimelineItem): string {
  if (typeof item.content === 'string') return item.content
  const content = objectValue(item.content)
  if (typeof content.text === 'string') return content.text
  const blocks = Array.isArray(content.parts)
    ? content.parts
    : Array.isArray(content.blocks)
      ? content.blocks
      : []
  return blocks
    .map((block) => objectValue(block).text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
}

/** 只有连续事件才推进游标；间隙由订阅层重新获取快照。 */
export function applySessionEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
): 'applied' | 'duplicate' | 'refetch' {
  if (
    event.protocolVersion !== runtimeContract.protocolVersion ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.cursor !== `seq:${event.sequence}` ||
    !/^seq:\d+$/.test(snapshot.eventCursor)
  )
    return 'refetch'
  const cursor = Number(snapshot.eventCursor.replace('seq:', ''))
  if (event.sequence <= cursor) return 'duplicate'
  if (
    event.sequence !== cursor + 1 ||
    event.type === 'session.refetch_required'
  )
    return 'refetch'
  if (
    event.type === 'timeline.item_created' ||
    event.type === 'timeline.item_updated'
  ) {
    const item = objectValue(event.payload.item)
    if (typeof item.id !== 'string' || typeof item.type !== 'string')
      return 'refetch'
    snapshot.timeline.items = mergeTimeline(snapshot.timeline.items, [
      item as TimelineItem,
    ])
  } else if (event.type === 'runtime.state.updated') {
    snapshot.state = { ...snapshot.state, ...objectValue(event.payload.state) }
    if (typeof snapshot.state.status === 'string')
      snapshot.session.status = snapshot.state.status
  } else if (
    event.type === 'session.meta.updated' ||
    event.type === 'notice.upsert' ||
    event.type === 'runtime.notice.updated' ||
    event.type === 'session.turn_ended' ||
    event.type === 'runtime.capability.updated' ||
    event.type === 'session.source.updated'
  )
    return 'refetch'
  snapshot.eventCursor = event.cursor
  return 'applied'
}
