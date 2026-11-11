import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { conversationApi } from '@/api/workbench/conversation-api'
import { apiUrl } from '@/utils/api-config'
import { sessionController } from '@/store/session-controller'
import { applySessionEvent, objectValue } from '@/utils/workbench/timeline'
import type { SessionEvent, SessionSnapshot } from '@/types/workbench/models'

/** 一次性票据和持久游标恢复；页面离开仅断开观察，不中断任务。 */
export function useSessionStream(
  selected: Ref<string>,
  snapshot: Ref<SessionSnapshot | null>,
  refresh: () => Promise<void>,
) {
  const status = ref<'connecting' | 'connected' | 'reconnecting' | 'offline'>(
    'offline',
  )
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let retries = 0
  let closed = false
  let accountGeneration = sessionController.generation
  const clientId = crypto.randomUUID()
  const clear = () => {
    generation++
    if (timer) clearTimeout(timer)
    timer = null
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
  }
  async function connect(): Promise<void> {
    if (closed || !selected.value || !snapshot.value) return
    const started = ++generation
    const identity = sessionController.generation
    const id = selected.value
    status.value = retries ? 'reconnecting' : 'connecting'
    try {
      const issued = await conversationApi.ticket(id, clientId)
      if (
        started !== generation ||
        identity !== sessionController.generation ||
        closed
      )
        return
      const url = new URL(
        apiUrl(`/sessions/${encodeURIComponent(id)}/ws`, {
          ticket: issued.ticket,
          clientId,
          cursor: snapshot.value.eventCursor,
        }),
        window.location.origin,
      )
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const current = new WebSocket(url)
      socket = current
      let pending = Promise.resolve()
      let queued = 0
      current.onopen = () => {
        if (started !== generation || closed) {
          current.close()
          return
        }
        status.value = 'connected'
        retries = 0
      }
      current.onmessage = (message: MessageEvent<string>) => {
        // 慢渲染积压时主动重连，服务端持久游标负责补齐，避免浏览器无限缓冲。
        if (message.data.length > 8 * 1024 * 1024 || ++queued > 256) {
          current.close()
          return
        }
        pending = pending
          .then(async () => {
            if (started !== generation || !snapshot.value) return
            const value = objectValue(JSON.parse(message.data))
            if (
              typeof value.sequence !== 'number' ||
              typeof value.eventId !== 'string' ||
              value.sessionId !== id
            )
              return
            if (
              applySessionEvent(
                snapshot.value,
                value as unknown as SessionEvent,
              ) === 'refetch'
            )
              await refresh()
          })
          .catch(() => {
            current.close()
          })
          .finally(() => {
            queued--
          })
      }
      current.onclose = () => {
        if (started === generation && !closed) retry()
      }
      current.onerror = () => current.close()
    } catch {
      if (started === generation && !closed) retry()
    }
  }
  function retry(): void {
    status.value = 'reconnecting'
    retries++
    timer = setTimeout(
      () => {
        void connect()
      },
      Math.min(15000, 500 * 2 ** Math.min(retries, 5)),
    )
  }
  watch(selected, () => {
    clear()
    retries = 0
    status.value = 'offline'
  })
  const unsubscribe = sessionController.subscribe(() => {
    if (accountGeneration === sessionController.generation) return
    accountGeneration = sessionController.generation
    clear()
    status.value = 'offline'
  })
  onScopeDispose(() => {
    closed = true
    clear()
    unsubscribe()
  })
  return { status, connect, disconnect: clear }
}
