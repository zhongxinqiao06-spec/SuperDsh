import { apiClient } from '@/lib/api'

export type ServerAgent = {
  status: 'stopped' | 'starting' | 'running' | 'error'
  connectorId: string | null
  runtimeId: string | null
  projectId: string | null
  error: string | null
}

export const serverAgentApi = {
  get: () => apiClient.get<{ agent: ServerAgent }>('/server-agent'),
  prepare: () => apiClient.post<{ agent: ServerAgent }>('/server-agent', {}),
}
