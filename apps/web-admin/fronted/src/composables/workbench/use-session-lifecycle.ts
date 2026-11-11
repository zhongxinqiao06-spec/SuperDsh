import { ref, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { conversationApi } from '@/api/workbench/conversation-api'
import { sessionController } from '@/store/session-controller'
import { canControlSession } from '@/utils/workbench/session-access'
import type {
  SessionSnapshot,
  WorkspaceSession,
} from '@/types/workbench/models'

/** 会话删除确认与有界终止等待；账号、会话变化或页面卸载后禁止旧结果写入。 */
export function useSessionLifecycle(options: {
  selected: Ref<string>
  snapshot: Ref<SessionSnapshot | null>
  sessions: Ref<WorkspaceSession[]>
  signal: AbortSignal
  run(action: () => Promise<void>): Promise<void>
  refresh(): Promise<void>
  reload(): Promise<void>
  fresh(): void
  removeDraft(id: string): void
  report(message: string): void
}) {
  const interrupting = ref(false)
  const current = (identity: number) =>
    !options.signal.aborted && identity === sessionController.generation
  async function remove(row: WorkspaceSession): Promise<void> {
    const identity = sessionController.generation
    try {
      await ElMessageBox.confirm(
        '删除后此会话将从历史记录移除，分享链接失效，无法在这里恢复。已生成的独立文件保留。正在执行的任务请先终止。',
        '删除会话',
        {
          confirmButtonText: '删除',
          cancelButtonText: '取消',
          type: 'warning',
        },
      )
    } catch {
      return
    }
    if (!current(identity)) return
    await options.run(async () => {
      await conversationApi.remove(row.id)
      if (!current(identity)) return
      if (options.selected.value === row.id) options.fresh()
      options.removeDraft(row.id)
      options.sessions.value = options.sessions.value.filter(
        (item) => item.id !== row.id,
      )
      await options.reload()
    })
  }
  async function interrupt(): Promise<void> {
    if (
      interrupting.value ||
      !canControlSession(options.snapshot.value?.session)
    )
      return
    const id = options.selected.value,
      identity = sessionController.generation
    interrupting.value = true
    try {
      await options.run(async () => {
        const result = await conversationApi.interrupt(id)
        // 只提交一次中断；受理后轮询持久状态，不伪造 idle 或自动重复控制命令。
        const deadline = Date.now() + 15000
        while (current(identity) && id === options.selected.value) {
          await options.refresh()
          if (!current(identity) || id !== options.selected.value) return
          if (
            ['idle', 'error'].includes(
              options.snapshot.value?.session.status ?? '',
            )
          ) {
            await options.reload()
            if (
              result.missing &&
              current(identity) &&
              id === options.selected.value
            )
              options.report(
                '引擎中未找到此会话，已标记为异常。可以删除该记录后新建对话；原请求不会自动重发。',
              )
            return
          }
          if (Date.now() >= deadline)
            throw new Error(
              '终止请求已发送，引擎尚未确认停止，请稍后同步状态。',
            )
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve()
            const finish = () => {
              clearTimeout(timer)
              options.signal.removeEventListener('abort', finish)
              resolve()
            }
            const timer = setTimeout(finish, 500)
            options.signal.addEventListener('abort', finish, { once: true })
          })
        }
      })
    } finally {
      interrupting.value = false
    }
  }
  return { interrupting, interrupt, remove }
}
