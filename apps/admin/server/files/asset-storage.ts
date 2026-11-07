import { text, ApiError } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import type { FileLibrary } from './file-library.ts'

/** Existing blobs remain intact. Once mapped, reads use the verified object and never silently fall back. */
export async function readAssetContent(
  library: FileLibrary | undefined,
  row: Row,
): Promise<Buffer> {
  const kind = row.kind === 'knowledge' ? 'knowledge' : 'template'
  if (library && row.id) {
    const mapping = await library.legacy(kind, text(row.id), text(row.id))
    if (mapping)
      return (
        await library.readBuffer(
          text(mapping.owner_user_id),
          text(mapping.file_id),
        )
      ).content
  }
  if (row.file_storage_state === 'pending')
    throw new ApiError(
      503,
      '资料文件尚未完成存储，请恢复文件服务后重新上传同一文件',
    )
  if (!Buffer.isBuffer(row.content)) throw new ApiError(404, '资料原文不存在')
  return row.content
}
