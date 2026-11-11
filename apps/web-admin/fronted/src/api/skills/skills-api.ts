import { request } from '@/utils/request'
import type { ResourceHistory, ResourcePage } from '@/types/tools/tools'
import type {
  SkillCandidate,
  SkillDraft,
  SkillResource,
} from '@/types/skills/skills'
export const skillsApi = {
  list: (
    page: number,
    pageSize: number,
    search: string,
    signal?: AbortSignal,
  ) =>
    request<ResourcePage<SkillResource>>('/admin/skills', {
      query: { page, pageSize, search },
      signal,
    }),
  save: (body: SkillDraft, id?: string) =>
    request<{ skill: SkillResource }>(
      `/admin/skills${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PUT' : 'POST', body },
    ),
  delete: (id: string) =>
    request<void>(`/admin/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  publish: (id: string, version: number) =>
    request<{ skill: SkillResource }>(
      `/admin/skills/${encodeURIComponent(id)}/publish`,
      { method: 'POST', body: { version } },
    ),
  versions: (id: string, page: number, signal?: AbortSignal) =>
    request<ResourceHistory<SkillResource>>(
      `/admin/skills/${encodeURIComponent(id)}/versions`,
      { query: { page, pageSize: 10 }, signal },
    ),
  restore: (id: string, version: number, sourceVersion: number) =>
    request(`/admin/skills/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: { version, sourceVersion },
    }),
  match: (requestText: string, extensions: string[], skillIds: string[]) =>
    request<{ candidates: SkillCandidate[] }>('/admin/skills/match-preview', {
      method: 'POST',
      body: { request: requestText, extensions, skillIds },
    }),
  import: (
    contentBase64: string,
    requiredToolIds: string[],
    id?: string,
    version?: number,
  ) =>
    request('/admin/skills/import', {
      method: 'POST',
      body: { contentBase64, requiredToolIds, id, version },
      timeoutMs: 60_000,
    }),
  importExtension: (
    sourceId: string,
    sourceVersion: string,
    skillId: string,
    requiredToolIds: string[],
    id?: string,
    version?: number,
  ) =>
    request('/admin/skills/import-extension', {
      method: 'POST',
      body: { sourceId, sourceVersion, skillId, requiredToolIds, id, version },
      timeoutMs: 60_000,
    }),
}
