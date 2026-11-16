import type { WorkspaceSession } from '@/types/workbench/models'

/** 接管表示允许控制会话；归档或外部只读会话不能发送、确认或中断任务。 */
export function canControlSession(
  session: WorkspaceSession | null | undefined,
): boolean {
  return !!session && session.takeover && !session.archived
}

/** 未创建的草稿可以编辑；已创建会话还必须已接管且当前没有在执行任务。 */
export function canComposeSession(
  session: WorkspaceSession | null | undefined,
): boolean {
  return (
    !session ||
    (canControlSession(session) && ['idle', 'error'].includes(session.status))
  )
}

/** 保留未知引擎状态原值供诊断。 */
export function sessionStatusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: '空闲',
    running: '进行中',
    starting: '启动中',
    error: '异常',
    waiting_approval: '待确认',
    waiting_input: '待输入',
    completed: '已完成',
    interrupted: '已中断',
  }
  return labels[status] ?? status
}
