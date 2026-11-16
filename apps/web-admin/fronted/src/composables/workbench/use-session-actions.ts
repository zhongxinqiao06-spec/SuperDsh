import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import { sessionController } from '@/store/session-controller'
import { conversationApi } from '@/api/workbench/conversation-api'
import type { WorkspaceSession, SessionAction } from '@/types/workbench/models'
import { errorMessage } from '@/utils/errors'

/** 确认前后分别校验操作上下文；后端拒绝删除时保留草稿和列表。 */
export async function confirmSessionRemoval(
  row: WorkspaceSession,
  valid: () => boolean,
): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '删除后此会话将从历史记录移除，分享链接失效，无法在这里恢复。已生成的独立文件保留。正在执行的任务请先终止。',
      '删除会话',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return false
  }
  if (!valid()) return false
  await conversationApi.remove(row.id)
  return valid()
}
/** 历史列表和侧栏复用同一确认、保存和重复点击保护，等待确认时重新核对身份。 */
export function useSessionActions(options: {
  signal: AbortSignal
  refresh(row: WorkspaceSession): Promise<void>
  remove(row: WorkspaceSession): Promise<void>
  report(message: string): void
}) {
  const auth = useAuthStore()
  const valid = (identity: number) =>
    !options.signal.aborted &&
    auth.can('sessions.run') &&
    identity === sessionController.generation
  // 侧栏中的同一记录可能同时出现在多个分组，所有入口共享提交锁。
  const editingSession = ref(false)
  async function updateSession(
    row: WorkspaceSession,
    action: SessionAction,
  ): Promise<void> {
    if (editingSession.value || !auth.can('sessions.run')) return
    const identity = sessionController.generation
    editingSession.value = true
    try {
      if (action === 'delete') {
        await options.remove(row)
        return
      }

      const changes =
        action === 'rename'
          ? {
              title: (
                await ElMessageBox.prompt('输入会话标题', '重命名', {
                  inputValue: row.title,
                })
              ).value,
            }
          : action === 'pin'
            ? { pinned: !row.pinned }
            : { archived: !row.archived }
      if (!valid(identity)) return
      await conversationApi.update(row.id, changes)
      if (valid(identity)) await options.refresh(row)
    } catch (cause) {
      if (cause !== 'cancel' && cause !== 'close' && valid(identity))
        options.report(errorMessage(cause))
    } finally {
      editingSession.value = false
    }
  }
  return { editingSession, updateSession }
}
