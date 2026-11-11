import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import { sessionController } from '@/store/session-controller'
import { ApiError } from '@/utils/errors'
import { downloadContent } from '@/utils/files/download-content'

/** 阶段与成果目录保留真实输出；页面不会将模型正文当作执行证据。 */
export interface SkillRunView {
  id: string
  state: string
  revision: number
  stageIndex: number
  skillName?: string
  stages: { id: string; name?: string; operation: string; state?: string }[]
  outputs: Record<string, unknown>
}
export interface ArtifactView {
  id: string
  name: string
  mediaType: string
  sha256: string
  deliverable?: boolean
  renderedQuality?: { status?: string }
}
export interface ArtifactPreview {
  name: string
  mediaType: string
  contentBase64: string
  missingFonts: string[]
}
const path = (session: string) => `/sessions/${encodeURIComponent(session)}`

export const resultApi = {
  runs: (session: string, signal?: AbortSignal) =>
    request<{ items: SkillRunView[] }>(`${path(session)}/skill-runs`, {
      signal,
    }),
  artifacts: (session: string, signal?: AbortSignal) =>
    request<{ items: ArtifactView[] }>(`${path(session)}/agent-artifacts`, {
      signal,
    }),
  preview: (session: string, artifact: string, signal?: AbortSignal) =>
    request<ArtifactPreview>(
      `${path(session)}/agent-artifacts/${encodeURIComponent(artifact)}/preview`,
      { signal },
    ),
  attachment: async (session: string, file: string, signal?: AbortSignal) =>
    downloadContent(
      await request<{
        contentBase64: string
        mediaType?: string
        contentType?: string
      }>(`${path(session)}/attachments/${encodeURIComponent(file)}`, {
        signal,
        timeoutMs: 60_000,
      }),
    ),
  artifact: (session: string, artifact: string, signal?: AbortSignal) =>
    download(
      `${path(session)}/agent-artifacts/${encodeURIComponent(artifact)}/download`,
      signal,
    ),
}

/** 二进制同样检查账号代际；401仅续期一次，不重复任何生成请求。 */
async function download(resource: string, signal?: AbortSignal): Promise<Blob> {
  const generation = sessionController.generation
  const token = sessionController.current?.accessToken
  if (!token) throw new ApiError('请先登录', 401)
  const options = {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}` },
  }
  let response = await fetch(apiUrl(resource), options)
  if (response.status === 401 && generation === sessionController.generation) {
    const refreshed = await sessionController.refresh()
    if (refreshed && generation === sessionController.generation)
      response = await fetch(apiUrl(resource), {
        ...options,
        headers: { authorization: `Bearer ${refreshed.accessToken}` },
      })
  }
  if (!response.ok) throw new ApiError('文件下载失败', response.status)
  const data = await response.blob()
  if (generation !== sessionController.generation)
    throw new ApiError('账号已变化', 401)
  return data
}
