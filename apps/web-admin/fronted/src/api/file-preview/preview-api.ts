import {
  workspaceApi,
  downloadWorkspaceTransfer,
} from '@/api/workspace-files/workspace-api'
import { sessionController } from '@/store/session-controller'
import { previewSourceUrl } from '@/utils/file-preview/preview-location'
import type {
  PreviewLocation,
  PreviewSession,
} from '@/types/file-preview/preview'

/** 预览票据与原登录互斥，后端始终只允许票据绑定的单个文件。 */
export const previewApi = {
  exchange: workspaceApi.previewSession,
  async load(
    location: PreviewLocation,
    session: PreviewSession | null,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (location.sourceUrl) {
      const generation = sessionController.generation
      const token = sessionController.current?.accessToken
      const response = await fetch(
        previewSourceUrl(location.sourceUrl, window.location.origin),
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
          redirect: 'error',
          credentials: 'same-origin',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      )
      if (!response.ok || !response.body)
        throw new Error('文件不可用或预览权限已失效')
      const reader = response.body.getReader(),
        chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.length
          if (size > 64 * 1024 * 1024) throw new Error('文件超过预览大小限制')
          chunks.push(new Uint8Array(part.value))
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      if (token && generation !== sessionController.generation)
        throw new Error('账号状态已变化，请重新打开预览')
      return new Blob(chunks, {
        type: response.headers.get('content-type') ?? location.mediaType,
      })
    }
    if (session)
      return downloadWorkspaceTransfer(
        session.connectorId,
        await workspaceApi.previewRead(session.previewAccessToken, signal),
        signal,
      )
    return workspaceApi.download(
      location.connectorId,
      location.path,
      signal,
      location.root,
    )
  },
  text: workspaceApi.read,
  save: workspaceApi.write,
  list: workspaceApi.list,
}
