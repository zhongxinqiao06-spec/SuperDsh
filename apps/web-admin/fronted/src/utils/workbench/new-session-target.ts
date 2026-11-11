import type { WorkspaceProject } from '@/types/workbench/models'

/** 新会话始终绑定设备项目；受管项目可来自有执行权限的 prepare 响应，不越权读取项目目录。 */
export function newSessionTarget(
  connectorId: string,
  projectId: string,
  projects: WorkspaceProject[],
  managed: { connectorId?: string | null; projectId?: string | null } | null,
): { connectorId: string; projectId: string; cwd?: string } | null {
  if (!connectorId) return null
  const project = projects.find(
    (item) => item.id === projectId && item.connectorId === connectorId,
  )
  if (project)
    return { connectorId, projectId: project.id, cwd: project.workspacePath }
  if (
    managed?.connectorId === connectorId &&
    managed.projectId &&
    (!projectId || projectId === managed.projectId)
  )
    return { connectorId, projectId: managed.projectId }
  return null
}
