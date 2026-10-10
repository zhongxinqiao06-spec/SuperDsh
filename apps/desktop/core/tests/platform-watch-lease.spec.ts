import { expect, it, vi } from 'vitest'
import { PlatformRemote } from '../src/main/platform-remote.ts'
import type { PlatformAccount } from '../src/main/platform-account.ts'
it('a disposed old conversation cannot stop a replacement subscription', async () => {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    close = vi.fn()
    onmessage: ((event: { data: string }) => void) | null = null
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(_url: URL) {
      sockets.push(this)
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  const identity = { key: 'a'.repeat(64), generation: 1 }
  const account = {
    identity: () => identity,
    origin: 'https://platform.example',
    json: async () => ({ ticket: 'ticket' }),
  }
  const emit = vi.fn()
  const remote = new PlatformRemote(account as unknown as PlatformAccount, emit)
  try {
    await remote.watch('first-session', 'first-owner', identity)
    await remote.watch('second-session', 'second-owner', identity)
    const [first, second] = sockets
    if (!first || !second)
      throw new Error('Expected two independently owned sockets')
    expect(first.close).toHaveBeenCalledTimes(1)
    await remote.stopWatch('first-owner')
    expect(second.close).not.toHaveBeenCalled()
    first.onmessage?.({ data: '{"text":"stale"}' })
    expect(emit).not.toHaveBeenCalled()
    second.onmessage?.({ data: '{"text":"current"}' })
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'second-session',
      identity,
      event: { text: 'current' },
    })
    await remote.stopWatch('second-owner')
    expect(second.close).toHaveBeenCalledTimes(1)
  } finally {
    await remote.close()
    vi.unstubAllGlobals()
  }
})
