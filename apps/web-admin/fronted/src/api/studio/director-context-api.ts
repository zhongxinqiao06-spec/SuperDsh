import { request } from '@/utils/request'
import type {
  DirectorCapabilities,
  DirectorContextInput,
  DirectorContextResult,
} from '@/types/studio/director-context'

const contextPath = (project: string) =>
  '/studio/projects/' + encodeURIComponent(project) + '/director-context'
/** 图片理解、资料查询和项目引用统一由后端资料用例处理。 */
export const directorContextApi = {
  capabilities: (project: string, signal?: AbortSignal) =>
    request<DirectorCapabilities>(contextPath(project), { signal }),
  prepare: (
    project: string,
    body: DirectorContextInput,
    signal?: AbortSignal,
  ) =>
    request<DirectorContextResult>(contextPath(project), {
      method: 'POST',
      body,
      signal,
      timeoutMs: 180000,
    }),
}
