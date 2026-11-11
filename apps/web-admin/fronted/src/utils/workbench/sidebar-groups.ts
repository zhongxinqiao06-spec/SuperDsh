import type {
  WorkspaceConnector,
  WorkspaceProject,
  WorkspaceSession,
} from '@/types/workbench/models'

/** 保留服务端会话顺序；置顶单列、服务器会话不重复进入普通项目树。 */
export function sidebarGroups(
  devices: WorkspaceConnector[],
  projects: WorkspaceProject[],
  sessions: WorkspaceSession[],
  archived: boolean,
) {
  const servers = new Set(
    devices
      .filter((item) => item.executorKind === 'server-agent')
      .map((item) => item.id),
  )
  const serverSession = (item: WorkspaceSession) =>
    item.executorKind === 'server-agent' || servers.has(item.connectorId)
  const visible = sessions.filter((item) => item.archived === archived)
  const pinned = visible.filter((item) => !item.archived && item.pinned)
  const regular = visible.filter((item) => item.archived || !item.pinned)
  const projectIds = new Set(projects.map((item) => item.id))
  const projectGroups = sortSidebarProjects(projects, sessions)
    .filter((item) => !servers.has(item.connectorId))
    .map((project) => ({
      project,
      sessions: regular.filter((item) => item.projectId === project.id),
    }))
    .filter(
      (group) =>
        group.project.manuallyCreated === true || group.sessions.length > 0,
    )
  return {
    pinned,
    all: regular,
    server: regular.filter(serverSession),
    unassigned: regular.filter(
      (item) =>
        !serverSession(item) &&
        (!item.projectId || !projectIds.has(item.projectId)),
    ),
    pinnedProjects: projectGroups.filter((group) => group.project.pinned),
    projects: projectGroups.filter((group) => !group.project.pinned),
  }
}

/** 项目名称冲突只调整候选名称，不自动重发写操作。 */
export function availableProjectName(
  name: string,
  projects: Pick<WorkspaceProject, 'id' | 'name'>[],
  ignoreId?: string,
): string {
  const base = Array.from(name.trim() || 'Workspace')
    .slice(0, 255)
    .join('')
  const names = new Set(
    projects.filter((item) => item.id !== ignoreId).map((item) => item.name),
  )
  let value = base
  for (let index = 1; names.has(value); index++) {
    const suffix = ` (${index})`
    value =
      Array.from(base)
        .slice(0, 255 - suffix.length)
        .join('') + suffix
  }
  return value
}

/** 空手建项目优先；其余按服务端聚合和已加载会话中的最新活动排序，不依赖响应偶然顺序。 */
export function sortSidebarProjects(
  projects: readonly WorkspaceProject[],
  sessions: readonly WorkspaceSession[],
): WorkspaceProject[] {
  const timestamp = (value: string | null | undefined) => {
    const time = value ? Date.parse(value) : 0
    return Number.isFinite(time) ? time : 0
  }
  const loaded = new Map<string, number>()
  for (const session of sessions)
    if (session.projectId)
      loaded.set(
        session.projectId,
        Math.max(
          loaded.get(session.projectId) ?? 0,
          timestamp(session.sortAt || session.lastActivityAt),
        ),
      )
  const activity = (project: WorkspaceProject) =>
    Math.max(timestamp(project.lastActivityAt), loaded.get(project.id) ?? 0)
  const empty = (project: WorkspaceProject) =>
    Boolean(project.manuallyCreated) &&
    !project.lastActivityAt &&
    !loaded.has(project.id) &&
    project.activeSessionCount === 0 &&
    (project.sidebarSessionCounts?.active ?? 0) === 0 &&
    (project.sidebarSessionCounts?.archived ?? 0) === 0
  return [...projects].sort(
    (left, right) =>
      Number(empty(right)) - Number(empty(left)) ||
      activity(right) - activity(left) ||
      timestamp(right.createdAt) - timestamp(left.createdAt) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  )
}

/** Windows 设备的工作区比较忽略大小写与分隔符，POSIX 保留大小写并消解父目录。 */
export function workspacePathKey(
  path: string,
  deviceOs?: string | null,
): string {
  const source = path.trim(),
    windows =
      deviceOs === 'windows' ||
      /^[a-z]:[\\/]/i.test(source) ||
      source.startsWith('\\\\')
  const normalized = windows ? source.replaceAll('\\', '/') : source
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue
    if (!windows && part === '..') parts.pop()
    else parts.push(part)
  }
  const prefix =
    normalized.startsWith('//') && !normalized.startsWith('///')
      ? '//'
      : normalized.startsWith('/')
        ? '/'
        : ''
  const key = prefix + parts.join('/')
  return windows ? key.toLowerCase() : key
}

/** 同名判断和同工作区判断分开；仅在相同设备上识别目录绑定冲突。 */
export function findWorkspaceProject(
  projects: WorkspaceProject[],
  connectorId: string,
  path: string,
  deviceOs?: string | null,
): WorkspaceProject | undefined {
  const key = workspacePathKey(path, deviceOs)
  if (!key) return undefined
  return projects.find(
    (project) =>
      project.connectorId === connectorId &&
      workspacePathKey(project.workspacePath, deviceOs) === key,
  )
}

/** 根目录与 Windows 盘符使用通用候选名，避免自动生成不可读的盘符项目名。 */
export function workspaceName(path: string): string {
  const value = path.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:$/i.test(value) || /^\/\/[^/]+\/[^/]+$/.test(value)
    ? 'Workspace'
    : value.split('/').at(-1) || 'Workspace'
}
