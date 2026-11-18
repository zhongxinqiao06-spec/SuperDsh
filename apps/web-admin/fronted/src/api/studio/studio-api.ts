import type { CreationDefaults, ProjectBrief } from '@/types/studio/foundation'
import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import type { ServerAgent } from '@/api/workbench/runtime-api'
import type {
  DirectoryAsset,
  DirectoryJob,
  ProjectSummary,
  StudioPage,
  StudioPageQuery,
  Generation,
  Job,
  Project,
  StudioAsset,
  StudioCatalog,
  StudioDocument,
  StudioProject,
} from '@/types/studio/studio'

const projects = '/studio/projects'
const project = (id: string) => projects + '/' + encodeURIComponent(id)
/** 工程保存及付费请求均带上用户确认时的修订。 */
export const studioApi = {
  projects: () => request<Project[]>(projects),
  usage: (
    asset: string,
    project: string | null,
    page: number,
    pageSize: number,
    signal: AbortSignal,
  ) =>
    request<
      StudioPage<{
        project: string
        title: string
        music: boolean
        shots: { id: string; number: number; adopted: boolean }[]
        scenes?: { id: string; title: string }[]
        soundEffects?: { id: string; shotId: string | null }[]
      }>
    >('/studio/library/' + encodeURIComponent(asset) + '/usage', {
      query: { project: project ?? undefined, page, pageSize },
      signal,
    }),
  recover: (id: string, job: string) =>
    request<Job>(
      project(id) + '/jobs/' + encodeURIComponent(job) + '/recover',
      { method: 'POST' },
    ),
  projectPage: (
    query: StudioPageQuery & { lifecycle?: string },
    signal: AbortSignal,
  ) =>
    request<StudioPage<ProjectSummary>>(projects, {
      query: { ...query },
      signal,
    }),
  libraryPage: (
    query: StudioPageQuery & {
      scope: string
      kind: string
      kinds?: string
      category?: string
      archived?: boolean
    },
    signal: AbortSignal,
  ) =>
    request<StudioPage<DirectoryAsset>>('/studio/library', {
      query: {
        ...query,
        archived:
          query.archived === undefined ? undefined : String(query.archived),
      },
      signal,
    }),
  jobPage: (
    query: StudioPageQuery & { state: string; kind: string },
    signal: AbortSignal,
  ) =>
    request<StudioPage<DirectoryJob>>('/studio/jobs', {
      query: { ...query },
      signal,
    }),
  linkAsset: (id: string, asset: string) =>
    request<{ revision: number }>(
      project(id) + '/assets/' + encodeURIComponent(asset) + '/link',
      { method: 'POST' },
    ),
  creationDefaults: (signal?: AbortSignal) =>
    request<CreationDefaults>('/studio/creation-defaults', { signal }),
  create: (body: ProjectBrief & { requestKey: string }) =>
    request<Project>(projects, { method: 'POST', body }),
  updateBrief: (
    id: string,
    revision: number,
    body: ProjectBrief,
    requestKey: string,
  ) =>
    request<Project>(project(id), {
      method: 'PATCH',
      body: { ...body, revision, requestKey },
    }),
  archive: (
    id: string,
    revision: number,
    archived: boolean,
    requestKey: string,
  ) =>
    request<Project>(project(id) + '/archive', {
      method: 'POST',
      body: { revision, archived, requestKey },
    }),
  open: (id: string, signal?: AbortSignal) =>
    request<StudioProject>(project(id), { signal }),
  save: (
    id: string,
    revision: number,
    document: StudioDocument,
    label: string,
    requestKey?: string,
  ) =>
    request<{
      revision: number
      document?: StudioDocument
      assets?: StudioAsset[]
    }>(project(id), {
      method: 'PUT',
      body: { revision, document, label, requestKey },
    }),
  restore: (id: string, revision: number, version: number) =>
    request(project(id) + '/revisions/' + version + '/restore', {
      method: 'POST',
      query: { revision },
    }),
  review: (
    id: string,
    revision: number,
    proposalId: string,
    selected: string[],
  ) =>
    request(project(id) + '/proposal/review', {
      method: 'POST',
      body: { revision, proposalId, selected },
    }),
  catalog: () => request<StudioCatalog>('/studio/catalog'),
  asset: (
    body: Pick<
      StudioAsset,
      | 'name'
      | 'kind'
      | 'description'
      | 'voice'
      | 'fileId'
      | 'parent'
      | 'project'
    > & { requestKey?: string; expectedVersionId?: string },
  ) => request<StudioAsset>('/studio/assets', { method: 'POST', body }),
  library: () => request<StudioAsset[]>('/studio/assets'),
  chat: (id: string, agent?: string, purpose?: 'text-edit') =>
    request<{ sessionId: string }>(project(id) + '/conversation', {
      method: 'POST',
      query: { agent, purpose },
    }),
  /** 用户明确更新预置助手时才刷新冻结绑定，旧会话与已发布历史仍保留。 */
  refreshChat: (
    id: string,
    agentDefinitionId?: string,
    purpose?: 'text-edit',
  ) =>
    request<{ sessionId: string; agentId: string; updatedTools: number }>(
      project(id) + '/conversation/refresh',
      {
        method: 'POST',
        query: { agentDefinitionId, purpose: purpose ?? 'director' },
      },
    ),
  directorRuntime: (
    id: string,
    signal: AbortSignal,
    prepare = false,
    purpose?: 'text-edit',
  ) =>
    request<{ agent: ServerAgent }>(project(id) + '/conversation/runtime', {
      method: prepare ? 'POST' : 'GET',
      query: { purpose },
      signal,
    }),
  generate: (
    id: string,
    revision: number,
    requestKey: string,
    options: Generation,
  ) =>
    request<Job[]>(project(id) + '/jobs', {
      method: 'POST',
      body: { revision, requestKey, ...options },
    }),
  reference: async (id: string | null, asset: string, signal?: AbortSignal) => {
    const path =
      (id ? project(id) : '/studio') + '/assets/' + encodeURIComponent(asset)
    await request(path + '/access', { method: 'POST', signal })
    return apiUrl(id ? path : path + '/content')
  },
  collect: (id: string, job: string, title: string) =>
    request<StudioAsset>(
      project(id) + '/media/' + encodeURIComponent(job) + '/collect',
      { method: 'POST', body: { title } },
    ),
  media: async (
    id: string,
    job: string,
    download = false,
    signal?: AbortSignal,
  ) => {
    const path = project(id) + '/media/' + encodeURIComponent(job)
    await request(path + '/access', { method: 'POST', signal })
    return apiUrl(path, download ? { download: 'true' } : {})
  },
}
