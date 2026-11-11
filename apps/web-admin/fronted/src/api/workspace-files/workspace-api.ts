import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** 设备文件契约携带服务端摘要；保存必须回传读取时的条件。 */
export interface WorkspaceEntry {
  name: string
  path: string
  type: string
  isDirectory: boolean
  size: number
}
export interface WorkspaceText {
  path: string
  content: string
  sha256: string
  size: number
}
/** 下载描述符只授予单个文件的短期访问，客户端仍核对摘要。 */
export interface WorkspaceTransfer {
  transferId: string
  token: string
  name: string
  size: number
  sha256: string
  mediaType: string
  path: string
}
interface Result<T> {
  ok: boolean
  result: T
  error: unknown
}
export const workspaceApi = {
  list: async (
    connector: string,
    path: string,
    signal?: AbortSignal,
    root?: string,
  ) =>
    (
      await request<Result<{ path: string; entries: WorkspaceEntry[] }>>(
        `/connectors/${encodeURIComponent(connector)}/fs/list`,
        { method: 'POST', body: { path, ...(root ? { root } : {}) }, signal },
      )
    ).result,
  read: (
    connector: string,
    path: string,
    signal?: AbortSignal,
    root?: string,
  ) =>
    request<WorkspaceText>(
      `/connectors/${encodeURIComponent(connector)}/fs/readText`,
      { method: 'POST', body: { path, ...(root ? { root } : {}) }, signal },
    ),
  write: async (
    connector: string,
    path: string,
    content: string,
    ifMatch?: string,
    root?: string,
  ) =>
    (
      await request<Result<{ sha256: string }>>(
        `/connectors/${encodeURIComponent(connector)}/fs/write`,
        {
          method: 'POST',
          body: {
            path,
            content,
            ...(ifMatch ? { ifMatch } : {}),
            ...(root ? { root } : {}),
          },
        },
      )
    ).result,
  download: async (
    connector: string,
    path: string,
    signal?: AbortSignal,
    root?: string,
  ) => {
    const value = await request<Result<WorkspaceTransfer>>(
      `/connectors/${encodeURIComponent(connector)}/fs/read`,
      { method: 'POST', body: { path, ...(root ? { root } : {}) }, signal },
    )
    return downloadWorkspaceTransfer(connector, value.result, signal)
  },
  previewToken: (connector: string, path: string, root?: string) =>
    request<{ previewToken: string; expiresAt: string }>(
      `/connectors/${encodeURIComponent(connector)}/fs/preview-token`,
      { method: 'POST', body: { path, ...(root ? { root } : {}) } },
    ),
  previewSession: (previewToken: string, signal?: AbortSignal) =>
    request<{
      previewAccessToken: string
      connectorId: string
      root: string
      path: string
    }>('/connectors/fs/preview-session', {
      method: 'POST',
      body: { previewToken },
      auth: false,
      signal,
    }),
  previewRead: async (previewAccessToken: string, signal?: AbortSignal) =>
    (
      await request<Result<WorkspaceTransfer>>('/connectors/fs/preview/read', {
        method: 'POST',
        body: { previewAccessToken },
        auth: false,
        signal,
      })
    ).result,
}

/** 只构造本服务传输路径，拒绝跟随下载重定向并校验总大小和摘要。 */
export async function downloadWorkspaceTransfer(
  connector: string,
  transfer: WorkspaceTransfer,
  signal?: AbortSignal,
): Promise<Blob> {
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(70_000)])
    : AbortSignal.timeout(70_000)
  const response = await fetch(
    apiUrl(
      `/connectors/${encodeURIComponent(connector)}/fs/transfers/${encodeURIComponent(transfer.transferId)}`,
      { token: transfer.token },
    ),
    { signal: bounded, credentials: 'same-origin', redirect: 'error' },
  )
  if (!response.ok || !response.body)
    throw new Error('文件传输失败，请重新读取文件')
  const reader = response.body.getReader(),
    digest = sha256.create(),
    chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      bounded.throwIfAborted()
      const value = await reader.read()
      if (value.done) break
      size += value.value.length
      if (size > transfer.size || size > 64 * 1024 * 1024)
        throw new Error('文件传输大小不一致')
      digest.update(value.value)
      chunks.push(new Uint8Array(value.value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (size !== transfer.size || bytesToHex(digest.digest()) !== transfer.sha256)
    throw new Error('文件传输完整性校验失败')
  return new Blob(chunks, { type: transfer.mediaType })
}
