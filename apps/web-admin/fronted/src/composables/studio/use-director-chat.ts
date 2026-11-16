import { computed, onScopeDispose, ref, watch } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import { conversationApi } from '@/api/workbench/conversation-api'
import type {
  SessionSnapshot,
  UploadedAttachment,
} from '@/types/workbench/models'
import { ApiError } from '@/utils/errors'

/** 导演继续使用作品绑定的 DSH 会话，保存成功后才发送；请求重试复用消息身份。 */
export function useDirectorChat(options: {
  project: string
  existing: () => string | null
  active: () => boolean
  allowed: () => boolean
  save: () => Promise<void>
  purpose?: 'text-edit'
}) {
  const session = ref(options.existing() ?? ''),
    agent = ref('')
  const busy = ref(false),
    error = ref(''),
    progress = ref('')
  const snapshot = ref<SessionSnapshot>()
  const bindingOutdated = ref(false)
  const abort = new AbortController()
  let receipt = { text: '', id: '' }
  let pollError = ''
  const running = computed(() =>
    ['starting', 'running', 'waiting_approval', 'waiting_input'].includes(
      snapshot.value?.session.status ?? '',
    ),
  )
  async function refresh(signal = abort.signal) {
    if (!session.value || !options.allowed()) return
    const result = await conversationApi.snapshot(session.value, signal)
    if (!signal.aborted && options.allowed()) snapshot.value = result
  }
  watch(options.existing, (id) => {
    if (id && !session.value) session.value = id
  })
  // 抽屉关闭即取消轮询；作品退出取消启动等待，迟到响应不能回写已离开的页面。
  watch(
    () => options.active() && options.allowed() && session.value,
    (visible, _, cleanup) => {
      if (!visible) return
      const polling = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      async function poll() {
        try {
          await refresh(polling.signal)
          if (error.value === pollError) error.value = ''
          pollError = ''
        } catch (cause) {
          if (!polling.signal.aborted) {
            pollError = String(cause)
            error.value = pollError
          }
        } finally {
          if (!polling.signal.aborted) timer = setTimeout(poll, 2000)
        }
      }
      cleanup(() => {
        polling.abort()
        clearTimeout(timer)
      })
      void poll()
    },
    { immediate: true },
  )
  async function respond(id: string, response: Record<string, unknown>) {
    if (busy.value || !session.value || !options.allowed()) return
    busy.value = true
    try {
      await conversationApi.respond(session.value, id, response)
      await refresh()
    } catch (cause) {
      if (!abort.signal.aborted) error.value = String(cause)
    } finally {
      busy.value = false
    }
  }
  async function send(
    text: string,
    messageId?: string,
    attachments: UploadedAttachment[] = [],
  ): Promise<boolean> {
    if (busy.value || running.value || !options.allowed() || !text.trim())
      return false
    busy.value = true
    error.value = ''
    bindingOutdated.value = false
    progress.value = '正在保存本次故事'
    try {
      await options.save()
      abort.signal.throwIfAborted()
      if (!session.value)
        session.value = (
          await studioApi.chat(
            options.project,
            agent.value || undefined,
            options.purpose,
          )
        ).sessionId
      progress.value =
        options.purpose === 'text-edit'
          ? '正在连接剧本编辑助手'
          : '正在连接作品导演'
      let { agent: runtime } = await studioApi.directorRuntime(
        options.project,
        abort.signal,
        true,
        options.purpose,
      )
      const deadline = Date.now() + 90000
      while (runtime.status === 'starting' && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            abort.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, 750)
          abort.signal.addEventListener('abort', finish, { once: true })
        })
        abort.signal.throwIfAborted()
        runtime = (
          await studioApi.directorRuntime(
            options.project,
            abort.signal,
            false,
            options.purpose,
          )
        ).agent
      }
      if (runtime.status !== 'running')
        throw new Error(
          runtime.error ?? '导演暂未就绪，故事已保留，请稍后再试。',
        )
      if (!options.allowed())
        throw new Error('当前账号已没有运行导演会话的权限。')
      const signature = JSON.stringify([text, attachments])
      if (receipt.text !== signature)
        receipt = { text: signature, id: crypto.randomUUID() }
      progress.value = '正在提交本次安排'
      await conversationApi.send(session.value, {
        text,
        clientMessageId: messageId ?? receipt.id,
        attachments,
        selections: {},
      })
      abort.signal.throwIfAborted()
      receipt = { text: '', id: '' }
      progress.value = '已发送，建议到达后由你审阅采用。'
      // 发送成功后的状态读取失败不能伪装成发送失败，避免用户误重发。
      try {
        await refresh()
      } catch {
        pollError = '指令已发送，暂时无法同步进度，请稍后查看。'
        error.value = pollError
      }
      return true
    } catch (cause) {
      if (!abort.signal.aborted) {
        bindingOutdated.value =
          cause instanceof ApiError &&
          cause.code === 'tool_implementation_changed'
        error.value = cause instanceof Error ? cause.message : String(cause)
        progress.value = ''
      }
      return false
    } finally {
      busy.value = false
    }
  }
  onScopeDispose(() => abort.abort())
  async function interrupt() {
    if (!session.value || !options.allowed()) return
    await conversationApi.interrupt(session.value)
    progress.value = '已请求停止，已有工程和建议保留。'
    await refresh()
  }
  async function refreshBinding(): Promise<boolean> {
    if (busy.value || running.value || !options.allowed()) return false
    busy.value = true
    error.value = ''
    progress.value = '正在更新预置助手工具'
    try {
      await options.save()
      const restored = await studioApi.refreshChat(
        options.project,
        agent.value || undefined,
        options.purpose,
      )
      abort.signal.throwIfAborted()
      session.value = restored.sessionId
      snapshot.value = undefined
      bindingOutdated.value = false
      progress.value = '助手工具已更新，原稿和本次要求已保留。'
      return true
    } catch (cause) {
      if (!abort.signal.aborted) {
        error.value = cause instanceof Error ? cause.message : String(cause)
        progress.value = ''
      }
      return false
    } finally {
      busy.value = false
    }
  }
  return {
    session,
    agent,
    busy,
    running,
    error,
    progress,
    snapshot,
    bindingOutdated,
    refreshBinding,
    send,
    respond,
    interrupt,
  }
}
