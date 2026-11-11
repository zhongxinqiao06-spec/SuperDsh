import { request } from '@/utils/request'
import type {
  ConnectionInput,
  StorageConnection,
  StorageMigrations,
  StorageSettings,
  StorageUsage,
} from '@/types/storage/storage'

/** 存储管理 API；迁移结果由持久收据查询，不自动重发。 */
export const storageApi = {
  settings: (signal?: AbortSignal) =>
    request<StorageSettings>('/admin/storage', { signal }),
  usage: (signal?: AbortSignal) =>
    request<StorageUsage>('/admin/storage/usage', { signal }),
  migrations: (signal?: AbortSignal) =>
    request<StorageMigrations>('/admin/storage/migrations', { signal }),
  saveSettings: (
    value: Pick<StorageSettings, 'activeConnectionId' | 'revision' | 'policy'>,
  ) =>
    request<StorageSettings>('/admin/storage', { method: 'PUT', body: value }),
  saveConnection: (value: ConnectionInput, id?: string) =>
    request<StorageConnection>(
      `/admin/storage/connections${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: value },
    ),
  check: (id: string) =>
    request<{ ok: boolean }>(
      `/admin/storage/connections/${encodeURIComponent(id)}/check`,
      { method: 'POST', timeoutMs: 60_000 },
    ),
  cleanup: () =>
    request<{ removed: number; pending: number; scheduled: number }>(
      '/admin/storage/cleanup',
      {
        method: 'POST',
        timeoutMs: 120_000,
      },
    ),
}
