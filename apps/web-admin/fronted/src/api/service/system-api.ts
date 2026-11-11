import { request } from '@/utils/request'
import type {
  Announcement,
  AuditEntry,
  DashboardOverview,
  DashboardSettings,
  ServiceInformation,
  ServiceSettings,
} from '@/types/service/system'

/** 系统领域接口，不向视图泄露传输层路径拼接。 */
export const systemApi = {
  settings: (signal?: AbortSignal) =>
    request<ServiceSettings>('/admin/settings', { signal }),
  updateSettings: (body: Partial<ServiceSettings>) =>
    request<ServiceSettings>('/admin/settings', { method: 'PATCH', body }),
  information: (signal?: AbortSignal) =>
    request<ServiceInformation>('/admin/service', { signal }),
  announcement: (signal?: AbortSignal) =>
    request<Announcement>('/admin/announcement', { signal }),
  publish: (body: Pick<Announcement, 'enabled' | 'markdown' | 'revision'>) =>
    request<Announcement>('/admin/announcement', { method: 'PUT', body }),
  publicAnnouncement: (signal?: AbortSignal) =>
    request<{
      announcement: Pick<Announcement, 'markdown' | 'publishedAt'> | null
    }>('/announcement', { auth: false, signal }),
  audits: (
    page: number,
    pageSize: number,
    search: string,
    action: string,
    signal?: AbortSignal,
  ) =>
    request<{
      events: AuditEntry[]
      total: number
      page: number
      pageSize: number
    }>(
      `/admin/audit?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, action })}`,
      { signal },
    ),
  overview: (from: string, to: string, tz: string, signal?: AbortSignal) =>
    request<DashboardOverview>(
      `/admin/dashboard/overview?${new URLSearchParams({ from, to, tz })}`,
      { signal },
    ),
  dashboardSettings: (body: DashboardSettings) =>
    request<DashboardSettings>('/admin/dashboard/settings', {
      method: 'PATCH',
      body,
    }),
  snapshot: (date: string, tz: string) =>
    request(
      `/admin/dashboard/snapshots/${encodeURIComponent(date)}?${new URLSearchParams({ tz })}`,
      { method: 'POST' },
    ),
}
