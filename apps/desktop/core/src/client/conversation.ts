import type {
  ConversationMessage,
  ConversationSource,
  ConversationTarget,
} from '../contracts/conversation.ts'
import type { PlatformBridge, PlatformJson } from '../contracts/platform.ts'
export type * from '../contracts/conversation.ts'
export { conversationTargetKey } from '../contracts/conversation.ts'

const object = (
  value: PlatformJson | undefined,
): { [key: string]: PlatformJson } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const string = (value: PlatformJson | undefined): string =>
  typeof value === 'string' ? value : ''
function text(value: PlatformJson | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n')
  const content = object(value)
  return (
    string(content.text) ||
    string(content.markdown) ||
    text(content.blocks) ||
    string(content.output) ||
    string(content.message)
  )
}

/** AA's normalized timeline is presentation data, never a fabricated DSH journal. */
export function platformConversationMessages(
  items: readonly PlatformJson[],
): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>()
  for (const value of items) {
    const item = object(value)
    const id = string(item.id)
    if (!id) continue
    messages.set(id, {
      id,
      order: typeof item.orderSeq === 'number' ? item.orderSeq : 0,
      role: string(item.role),
      kind: string(item.type),
      status: string(item.status),
      text: text(item.content),
      content: object(item.content),
    })
  }
  return [...messages.values()].sort((left, right) => left.order - right.order)
}

export function createPlatformConversationSource(
  bridge: PlatformBridge,
  target: Extract<ConversationTarget, { kind: 'platform' }>,
  current: () => { identityKey: string | null; identityGeneration: number },
): ConversationSource {
  const check = (): string => {
    const identity = current()
    if (
      identity.identityKey !== target.identityKey ||
      identity.identityGeneration !== target.identityGeneration
    )
      throw new Error('账号已切换，请重新选择会话')
    if (!target.sessionId) throw new Error('请先选择会话')
    return target.sessionId
  }
  const identity = {
    key: target.identityKey,
    generation: target.identityGeneration,
  }
  return {
    target,
    async send(content, clientMessageId, attachments = []) {
      const sessionId = check()
      await bridge.request({
        identity,
        operation: 'send',
        sessionId,
        body: { content, clientMessageId, attachments },
      })
      check()
    },
    async cancel() {
      await bridge.request({
        identity,
        operation: 'interrupt',
        sessionId: check(),
      })
      check()
    },
    async history(beforeOrder) {
      const value = await bridge.request({
        identity,
        operation: 'timeline',
        sessionId: check(),
        query: {
          mode: 'history',
          limit: '200',
          ...(beforeOrder === undefined
            ? {}
            : { beforeOrderSeq: String(beforeOrder) }),
        },
      })
      check()
      return value
    },
  }
}

/** Native callers keep their actual SessionFace/queue; this seam owns no executor. */
export function createNativeConversationSource(
  target: Extract<ConversationTarget, { kind: 'native' }>,
  operations: Pick<ConversationSource, 'send' | 'cancel' | 'history'>,
): ConversationSource {
  return { target, ...operations }
}
