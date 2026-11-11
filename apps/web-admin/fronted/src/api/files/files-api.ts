import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import { responseError } from '@/utils/errors'
import { sessionController } from '@/store/session-controller'
import type { FileEntry, FileFilter, FileList } from '@/types/files/files'

/** 文件库接口不信任服务器返回的任意下载 URL，统一通过文件身份寻址。 */
export const filesApi = {
  list: (filter: FileFilter, signal?: AbortSignal) =>
    request<FileList>('/files', {
      query: { ...filter, deleted: String(filter.deleted) },
      signal,
    }),
  versions: (id: string, signal?: AbortSignal) =>
    request<{ items: FileEntry[] }>(
      `/files/${encodeURIComponent(id)}/versions`,
      { signal },
    ),
  trash: (id: string, restore = false) =>
    request<FileEntry>(
      `/files/${encodeURIComponent(id)}/${restore ? 'restore' : 'trash'}`,
      { method: 'POST' },
    ),
  migrate: (id: string, targetStorageId: string) =>
    request<{ state: string; migrationId?: string }>(
      `/files/${encodeURIComponent(id)}/migrate`,
      { method: 'POST', body: { targetStorageId }, timeoutMs: 120_000 },
    ),
}

/** 流式读取同时核对大小与摘要，取消/换号后不发布旧账号的文件内容。 */
export async function downloadFile(
  file: FileEntry,
  cancellation: AbortSignal,
): Promise<Blob> {
  const generation = sessionController.generation,
    token = sessionController.current?.accessToken
  if (!token) throw new Error('请先登录')
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(120_000)])
  const active = () => {
    signal.throwIfAborted()
    if (generation !== sessionController.generation)
      throw new Error('账号已变更')
  }
  const fetchContent = () =>
    fetch(apiUrl(`/files/${encodeURIComponent(file.id)}/content`), {
      headers: {
        Authorization: `Bearer ${sessionController.current?.accessToken ?? ''}`,
      },
      credentials: 'same-origin',
      signal,
    })
  let response = await fetchContent()
  if (response.status === 401) {
    await sessionController.refresh()
    active()
    response = await fetchContent()
  }
  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* 非 JSON 网关错误仍按状态呈现。 */
    }
    throw responseError(payload, response.status)
  }
  if (!response.body) throw new Error('文件下载未返回内容')
  const reader = response.body.getReader(),
    digest = sha256.create(),
    chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      active()
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > file.size) throw new Error('下载文件大小不一致')
      digest.update(item.value)
      chunks.push(new Uint8Array(item.value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  active()
  if (size !== file.size || bytesToHex(digest.digest()) !== file.sha256)
    throw new Error('下载文件摘要校验失败')
  return new Blob(chunks, { type: file.mediaType })
}
