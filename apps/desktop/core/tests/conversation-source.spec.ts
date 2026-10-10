import { expect, it, vi } from 'vitest'
import {
  conversationTargetKey,
  createPlatformConversationSource,
  platformConversationMessages,
} from '../src/client/conversation.ts'
import type { PlatformBridge, PlatformJson } from '../src/contracts/platform.ts'
import type { ConversationTarget } from '../src/contracts/conversation.ts'

const target: Extract<ConversationTarget, { kind: 'platform' }> = {
  kind: 'platform',
  identityKey: 'account-a',
  identityGeneration: 1,
  origin: 'https://platform.example',
  userId: 'alice',
  connectorId: 'computer',
  sessionId: 'session',
  externalSessionId: 'native-session',
}
it('keeps identity, generation and target in conversation keys', () => {
  expect(conversationTargetKey(target)).not.toBe(
    conversationTargetKey({ ...target, identityGeneration: 2 }),
  )
  expect(conversationTargetKey(target)).not.toBe(
    conversationTargetKey({
      ...target,
      identityKey: 'account-b',
      userId: 'bob',
    }),
  )
  expect(conversationTargetKey(target)).not.toBe(
    conversationTargetKey({ ...target, connectorId: 'other-computer' }),
  )
})
it('normalizes authoritative AA items without inventing native journal events', () => {
  const messages = platformConversationMessages([
    {
      id: 'assistant',
      role: 'assistant',
      orderSeq: 2,
      status: 'running',
      content: { text: 'partial' },
    },
    {
      id: 'user',
      role: 'user',
      orderSeq: 1,
      content: { blocks: [{ text: 'hello' }] },
    },
    {
      id: 'assistant',
      role: 'assistant',
      orderSeq: 2,
      status: 'completed',
      content: { text: 'complete' },
    },
  ])
  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['user', 'hello'],
    ['assistant', 'complete'],
  ])
  expect(messages[1]).not.toHaveProperty('seq')
  expect(messages[1]).not.toHaveProperty('turnId')
})
it('rejects stale identities before dispatch and discards late history', async () => {
  let identity = { identityKey: target.identityKey, identityGeneration: 1 }
  let settle: (value: PlatformJson) => void = () => {}
  const request = vi.fn(
    () =>
      new Promise<PlatformJson>((resolve) => {
        settle = resolve
      }),
  )
  const source = createPlatformConversationSource(
    { request } as Pick<PlatformBridge, 'request'> as PlatformBridge,
    target,
    () => identity,
  )
  const history = source.history(20)
  identity = { identityKey: 'account-b', identityGeneration: 2 }
  settle({ items: [{ id: 'private-history' }] })
  await expect(history).rejects.toThrow('账号已切换')
  await expect(source.send('stale', 'message')).rejects.toThrow('账号已切换')
  expect(request).toHaveBeenCalledTimes(1)
})
