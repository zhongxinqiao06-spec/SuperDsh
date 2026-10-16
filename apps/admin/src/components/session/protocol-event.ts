import type { ProtocolEventEnvelope } from '@/features/dashboard/types'

export function parseProtocolEvent(data: string): ProtocolEventEnvelope | null {
  try {
    const event = JSON.parse(data) as Partial<ProtocolEventEnvelope>
    if (!event || typeof event.type !== 'string') return null
    if (event.type === 'keepalive') return null
    if (
      event.protocolVersion !== '1.0' ||
      typeof event.eventId !== 'string' ||
      typeof event.emittedAt !== 'string' ||
      typeof event.sessionId !== 'string' ||
      typeof event.sequence !== 'number' ||
      typeof event.cursor !== 'string'
    ) {
      return null
    }
    return {
      protocolVersion: event.protocolVersion,
      eventId: event.eventId,
      sequence: event.sequence,
      cursor: event.cursor,
      type: event.type,
      sessionId: event.sessionId,
      emittedAt: event.emittedAt,
      payload: event.payload ?? {},
    }
  } catch {
    return null
  }
}
