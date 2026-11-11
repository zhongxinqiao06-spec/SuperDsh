import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import { responseError } from '@/utils/errors'
import { sessionController } from '@/store/session-controller'
import type { UploadedAttachment } from '@/types/workbench/models'
import { sha256 as createDigest } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

interface UploadState {
  id: string
  state: string
  partSize: number
  receivedParts: number[]
  fileId?: string
}

/** 文件对象不会写入浏览器存储；只保留当前账号断点的操作身份。 */
export async function uploadFile(
  file: File,
  signal?: AbortSignal,
  onProgress?: (percentage: number) => void,
  previousFileId?: string,
): Promise<UploadedAttachment> {
  const generation = sessionController.generation
  const owner = sessionController.current?.userId
  if (!owner) throw new Error('请先登录')
  // 分块摘要避免大文件在校验阶段一次复制完整内容；每块核对取消与身份代际。
  const digest = createDigest.create(),
    blockSize = 8 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += blockSize) {
    signal?.throwIfAborted()
    if (generation !== sessionController.generation)
      throw new Error('账号已变更')
    digest.update(
      new Uint8Array(
        await file.slice(offset, offset + blockSize).arrayBuffer(),
      ),
    )
  }
  const sha256 = bytesToHex(digest.digest())
  const key = `superdsh:upload:${owner}:${sha256}:${file.size}:${previousFileId ?? ''}:${file.name}`
  const operation = localStorage.getItem(key) ?? crypto.randomUUID()
  localStorage.setItem(key, operation)
  const state = await request<UploadState>('/files/uploads', {
    method: 'POST',
    body: {
      name: file.name,
      size: file.size,
      sha256,
      mediaType: file.type || 'application/octet-stream',
      idempotencyKey: operation,
      ...(previousFileId ? { previousFileId } : {}),
    },
    signal,
  })
  if (state.state === 'cancelled') {
    localStorage.removeItem(key)
    throw new Error('上传已过期，请重新选择文件')
  }
  const count = Math.ceil(file.size / state.partSize)
  for (let part = 1; part <= count && state.state !== 'completed'; part++) {
    if (signal?.aborted || generation !== sessionController.generation)
      throw new Error('上传已取消或账号已变更')
    if (!state.receivedParts.includes(part)) {
      const response = await fetch(
        apiUrl(`/files/uploads/${encodeURIComponent(state.id)}/parts/${part}`),
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${sessionController.current?.accessToken ?? ''}`,
            'content-type': 'application/octet-stream',
          },
          body: file.slice((part - 1) * state.partSize, part * state.partSize),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
          credentials: 'same-origin',
        },
      )
      if (!response.ok)
        throw responseError(await response.json(), response.status)
    }
    onProgress?.(Math.round((part / count) * 100))
  }
  const entry = state.fileId
    ? await request<Record<string, unknown>>(
        `/files/${encodeURIComponent(state.fileId)}`,
        { signal },
      )
    : await request<Record<string, unknown>>(
        `/files/uploads/${encodeURIComponent(state.id)}/complete`,
        { method: 'POST', signal },
      )
  if (generation !== sessionController.generation) throw new Error('账号已变更')
  localStorage.removeItem(key)
  const value =
    entry.file && typeof entry.file === 'object'
      ? (entry.file as Record<string, unknown>)
      : entry
  return {
    fileId: String(value.id),
    name: String(value.name),
    mediaType: String(value.mediaType),
    size: Number(value.size),
    sha256: String(value.sha256),
  }
}
