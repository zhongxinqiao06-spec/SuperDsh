import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useSessionStream } from '@/composables/workbench/use-session-stream'
import type { SessionSnapshot } from '@/types/workbench/models'
import runtimeContract from '../../contracts/dsh-runtime.json'

const api = vi.hoisted(() => ({
  ticket: vi.fn(),
  listeners: new Set<() => void>(),
  identity: { generation: 1 },
}))
vi.mock('@/api/workbench/conversation-api', () => ({
  conversationApi: { ticket: api.ticket },
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return api.identity.generation
    },
    subscribe: (listener: () => void) => {
      api.listeners.add(listener)
      return () => api.listeners.delete(listener)
    },
  },
}))
class ControlledSocket {
  static instances: ControlledSocket[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  closed = false
  constructor(public url: string) {
    ControlledSocket.instances.push(this)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  emit(sequence: number, payload: object, sessionId = 's') {
    this.onmessage?.({
      data: JSON.stringify({
        protocolVersion: runtimeContract.protocolVersion,
        eventId: `event-${sequence}`,
        sequence,
        cursor: `seq:${sequence}`,
        sessionId,
        type: 'timeline.item_created',
        payload,
      }),
    })
  }
}
function snapshot(): SessionSnapshot {
  return {
    session: {
      id: 's',
      connectorId: 'c',
      projectId: null,
      runtimeId: 'dsh',
      runtime: 'dsh',
      title: '',
      cwd: '',
      status: 'idle',
      pinned: false,
      archived: false,
      takeover: false,
      unread: false,
      updatedSeq: 0,
      agentDefinition: null,
    },
    state: {},
    timeline: { items: [], nextSeq: null, hasMore: false },
    notices: [],
    approvals: [],
    effectiveCapabilities: {},
    eventCursor: 'seq:0',
  }
}
beforeEach(() => {
  api.ticket.mockResolvedValue({ ticket: 'single-use' })
  api.listeners.clear()
  api.identity.generation = 1
  ControlledSocket.instances = []
  vi.stubGlobal('WebSocket', ControlledSocket)
})
afterEach(() => vi.useRealTimers())

describe('会话订阅隔离与断线恢复', () => {
  it('连续事件合并、重复去重、间隙取快照，切会话后旧事件不能覆盖', async () => {
    const selected = ref('s'),
      value = ref<SessionSnapshot | null>(snapshot()),
      scope = effectScope()
    const refresh = vi.fn(async () => {
      if (value.value) value.value.eventCursor = 'seq:3'
    })
    const stream = scope.run(() => useSessionStream(selected, value, refresh))!
    await stream.connect()
    const socket = ControlledSocket.instances[0]!
    socket.onopen?.()
    for (const listener of api.listeners) listener()
    expect(socket.closed).toBe(false)
    expect(stream.status.value).toBe('connected')
    socket.emit(1, { item: { id: 'one', type: 'message', content: 'text' } })
    socket.emit(1, {
      item: { id: 'one', type: 'message', content: 'duplicate' },
    })
    await flushPromises()
    expect(value.value?.timeline.items).toHaveLength(1)
    expect(value.value?.timeline.items[0]?.content).toBe('text')
    socket.emit(3, { item: { id: 'three', type: 'message' } })
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(value.value?.eventCursor).toBe('seq:3')
    selected.value = 'other'
    await flushPromises()
    socket.emit(4, { item: { id: 'late', type: 'message' } })
    await flushPromises()
    expect(value.value?.timeline.items).toHaveLength(1)
    expect(socket.closed).toBe(true)
    scope.stop()
    expect(api.listeners.size).toBe(0)
  })
  it('票据返回前换账号不建立连接，重连计时器随卸载撤销', async () => {
    let resolve!: (value: { ticket: string }) => void
    api.ticket.mockImplementationOnce(
      () =>
        new Promise<{ ticket: string }>((done) => {
          resolve = done
        }),
    )
    const selected = ref('s'),
      value = ref<SessionSnapshot | null>(snapshot()),
      scope = effectScope()
    const stream = scope.run(() =>
      useSessionStream(selected, value, async () => undefined),
    )!
    const pending = stream.connect()
    api.identity.generation++
    for (const listener of api.listeners) listener()
    resolve({ ticket: 'old-identity' })
    await pending
    expect(ControlledSocket.instances).toHaveLength(0)
    vi.useFakeTimers()
    await stream.connect()
    ControlledSocket.instances[0]!.close()
    scope.stop()
    await vi.advanceTimersByTimeAsync(20000)
    expect(ControlledSocket.instances).toHaveLength(1)
  })
})
