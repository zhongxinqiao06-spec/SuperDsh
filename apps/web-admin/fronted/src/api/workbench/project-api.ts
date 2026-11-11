import { request } from '@/utils/request'
import type { WorkspaceProject } from '@/types/workbench/models'

/** 项目目录选择保留失败与目标类型，不能把文件或 RPC 失败当作可保存目录。 */
interface DirectoryResponse {
  ok: boolean
  result?: {
    path: string
    targetType?: string
    entries: {
      name: string
      path: string
      type?: string
      isDirectory?: boolean
    }[]
  }
  error?: { message?: string } | string
}

/** 项目树的批量动作复用旧业务契约，结果由调用方重新读取，不能推测成功数量。 */
export const projectApi = {
  directory: async (
    connectorId: string,
    path: string,
    windows: boolean,
    signal?: AbortSignal,
  ) => {
    const target = path.trim() || (windows ? '' : '/')
    const response = await request<DirectoryResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/list`,
      {
        method: 'POST',
        body: { root: target || '~', path: target ? '.' : '' },
        signal,
      },
    )
    if (!response.ok)
      throw new Error(
        typeof response.error === 'string'
          ? response.error
          : response.error?.message || '目录读取失败',
      )
    const result = response.result
    if (
      !result ||
      typeof result.path !== 'string' ||
      !Array.isArray(result.entries)
    )
      throw new Error('目录响应不完整，请刷新后重试')
    if (result.targetType === 'file')
      throw new Error('请选择目录，不能使用普通文件作为工作区')
    return {
      path: result.path,
      directories: result.entries
        .filter(
          (entry) =>
            (entry.type === 'directory' || entry.isDirectory === true) &&
            typeof entry.name === 'string' &&
            typeof entry.path === 'string',
        )
        .map((entry) => ({ name: entry.name, path: entry.path }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  },
  save: (
    body: { name: string; connectorId: string; workspacePath: string },
    id?: string,
  ) =>
    request<{ project: WorkspaceProject }>(
      `/projects${id ? '/' + encodeURIComponent(id) : ''}`,
      {
        method: id ? 'PATCH' : 'POST',
        body: id ? { name: body.name } : body,
      },
    ),
  pin: (id: string, pinned: boolean) =>
    request(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { pinned },
    }),
  archive: (
    id: string,
    archived: boolean,
    scope: 'active' | 'archived' | 'all' = 'all',
  ) =>
    request(`/projects/${encodeURIComponent(id)}/sessions/archive-all`, {
      method: 'POST',
      body: { archived, scope },
    }),
  read: (ids: string[]) =>
    request('/sessions/read', { method: 'POST', body: ids }),
}
