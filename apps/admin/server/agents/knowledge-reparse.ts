import { createHash } from 'node:crypto'
import { ApiError, text } from '../http/api-router.ts'
import {
  json,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import { extractKnowledgeText } from './office/knowledge.ts'
import { OfficeInputError } from './office/types.ts'
import { readAssetContent } from '../files/asset-storage.ts'
import type { FileLibrary } from '../files/file-library.ts'

export function hasKnowledgeSegments(row: Row) {
  const segments = Array.isArray(row.source_segments_json)
    ? row.source_segments_json
    : json<unknown[]>(row.source_segments_json, [])
  return Array.isArray(segments) && segments.length > 0
}

/** Explicit maintainer operation only: never runs in migrations or question handling. */
export async function reparseLegacyKnowledgeAsset(
  db: SqlConnection,
  owner: string,
  row: Row,
  signal: AbortSignal,
  library?: FileLibrary,
): Promise<Row> {
  if (hasKnowledgeSegments(row)) return row
  signal.throwIfAborted()
  const [stored] = await db.query(
    "SELECT id,name,sha256,content,extracted_text,source_segments_json,file_storage_state FROM business_agent_assets WHERE id=$1 AND owner_user_id=$2 AND kind='knowledge'",
    [row.id, owner],
  )
  if (!stored) throw new ApiError(404, '资料不存在或无权维护')
  stored.kind = 'knowledge'
  stored.content = await readAssetContent(library, stored)
  if (stored.sha256 !== row.sha256)
    throw new ApiError(409, '资料已变化，请刷新后重试')
  if (hasKnowledgeSegments(stored)) return stored
  if (
    !Buffer.isBuffer(stored.content) ||
    createHash('sha256').update(stored.content).digest('hex') !== stored.sha256
  )
    throw new ApiError(409, '资料原始文件校验失败，已保留原记录，请从备份恢复')
  let extracted
  try {
    extracted = await extractKnowledgeText(
      { filename: text(stored.name), content: stored.content },
      signal,
    )
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof OfficeInputError)
      throw new ApiError(422, `${text(stored.name)}：${error.message}`)
    throw error
  }
  signal.throwIfAborted()
  const [updated] = await db.query(
    'UPDATE business_agent_assets SET extracted_text=$1,source_segments_json=$2::jsonb WHERE id=$3 AND owner_user_id=$4 AND sha256=$5 RETURNING id,name,sha256,extracted_text,source_segments_json',
    [
      extracted.text,
      JSON.stringify(extracted.segments),
      row.id,
      owner,
      row.sha256,
    ],
  )
  if (!updated) throw new ApiError(409, '资料已变化，请刷新后重试')
  return updated
}
