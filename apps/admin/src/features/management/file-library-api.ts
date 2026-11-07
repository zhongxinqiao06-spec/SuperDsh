import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { FileEntry, FileUpload } from '@superdsh/core/contracts/platform'
import { apiClient, apiPath } from '@/lib/api'
import {
  loadStoredSession,
  refreshSession,
  sessionIdentityRevision,
} from '@/features/auth/session'

export async function uploadLibraryFile(
  file: File,
  signal: AbortSignal,
  progress: (message: string) => void,
  previousFileId?: string,
) {
  const identity = sessionIdentityRevision(),
    digest = sha256.create(),
    blockSize = 8 * 1024 * 1024
  const active = () => {
    signal.throwIfAborted()
    if (identity !== sessionIdentityRevision())
      throw new Error('账号已切换，传输已停止')
  }
  for (let offset = 0; offset < file.size; offset += blockSize) {
    active()
    digest.update(
      new Uint8Array(
        await file.slice(offset, offset + blockSize).arrayBuffer(),
      ),
    )
    progress(
      `校验文件 ${Math.min(100, Math.round(((offset + blockSize) * 100) / file.size))}%`,
    )
  }
  active()
  const checksum = bytesToHex(digest.digest())
  // Re-selecting the same file resumes parts without retaining credentials or file bytes in browser storage.
  const upload = await apiClient.post<FileUpload>(
    '/files/uploads',
    {
      name: file.name,
      size: file.size,
      mediaType: file.type || 'application/octet-stream',
      sha256: checksum,
      previousFileId,
      idempotencyKey: `${checksum}:${previousFileId || ''}:${file.name}`.slice(
        0,
        160,
      ),
    },
    { signal },
  )
  for (
    let offset = 0, part = 1;
    offset < file.size;
    offset += upload.partSize, part++
  ) {
    active()
    if (!upload.receivedParts.includes(part))
      await apiClient.put(
        `/files/uploads/${encodeURIComponent(upload.id)}/parts/${part}`,
        file.slice(offset, offset + upload.partSize),
        { signal, headers: { 'Content-Type': 'application/octet-stream' } },
      )
    progress(
      `上传 ${Math.min(100, Math.round(((offset + upload.partSize) * 100) / file.size))}%`,
    )
  }
  active()
  return apiClient.post<FileEntry>(
    `/files/uploads/${encodeURIComponent(upload.id)}/complete`,
    {},
    { signal },
  )
}

export async function downloadLibraryFile(
  file: FileEntry,
  signal: AbortSignal,
): Promise<Blob> {
  const identity = sessionIdentityRevision()
  const request = () =>
    fetch(apiPath(`/files/${encodeURIComponent(file.id)}/content`), {
      signal,
      headers: { Authorization: 'Bearer ' + loadStoredSession()?.accessToken },
    })
  let response = await request()
  if (response.status === 401) {
    await refreshSession(apiPath('/auth/refresh'))
    if (identity !== sessionIdentityRevision()) throw new Error('账号已切换')
    response = await request()
  }
  if (!response.ok || !response.body)
    throw new Error('文件下载失败，请刷新后重试')
  const reader = response.body.getReader(),
    digest = sha256.create(),
    chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      if (identity !== sessionIdentityRevision()) throw new Error('账号已切换')
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > file.size) throw new Error('下载内容大小不一致')
      digest.update(item.value)
      chunks.push(new Uint8Array(item.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (size !== file.size || bytesToHex(digest.digest()) !== file.sha256)
    throw new Error('下载文件校验失败')
  return new Blob(chunks, { type: file.mediaType })
}
