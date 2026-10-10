import type { PlatformJson } from './platform.ts'

/** A native ID and an API v2 ID belong to different address spaces. */
export type ConversationTarget =
  | { kind: 'native'; sessionId: string | null }
  | {
      kind: 'platform'
      identityKey: string
      identityGeneration: number
      origin: string
      userId: string
      connectorId: string
      executorKind?: 'desktop' | 'server-agent'
      runtimeId?: string | null
      sessionId: string | null
      externalSessionId: string | null
    }

export interface ConversationMessage {
  id: string
  order: number
  role: string
  kind: string
  status: string
  text: string
  content: { [key: string]: PlatformJson }
}

export interface ConversationSource {
  readonly target: ConversationTarget
  send(
    content: string,
    clientMessageId: string,
    attachments?: PlatformJson[],
  ): Promise<void>
  cancel(): Promise<void>
  history(beforeOrder?: number): Promise<PlatformJson>
}

export function conversationTargetKey(target: ConversationTarget): string {
  return target.kind === 'native'
    ? JSON.stringify(['native', target.sessionId])
    : JSON.stringify([
        target.identityKey,
        target.identityGeneration,
        target.connectorId,
        target.sessionId,
      ])
}
