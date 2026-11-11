import { request } from '@/utils/request'

/** 引擎状态取自Python监督器，不能用首页存活替代执行就绪。 */
export interface ServerAgent {
  status: 'stopped' | 'starting' | 'running' | 'error'
  connectorId: string | null
  runtimeId: string | null
  projectId: string | null
  error: string | null
}

/** 仅工作台生命周期可调用准备操作，管理模块不依赖此API。 */
export const runtimeApi = {
  get: (signal?: AbortSignal) =>
    request<{ agent: ServerAgent }>('/server-agent', { signal }),
  prepare: () =>
    request<{ agent: ServerAgent }>('/server-agent', {
      method: 'POST',
      body: {},
    }),
}
