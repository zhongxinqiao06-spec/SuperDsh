import { ApiError, text, utcNow } from '../http/api-router.ts'
import { json, type Row } from '../infrastructure/database.ts'
import type { BusinessAgentService } from './service.ts'
import { officeHash } from './office-sources.ts'
import {
  renderOfficeAssetPreview,
  type OfficeAssetPreview,
} from './office/preview.ts'
import type { OfficeInputFile } from './office/types.ts'
import { renderedQuality } from './office/rendered-quality-client.ts'
import type { RenderedQuality } from './office/rendered-quality.ts'
import { imageData } from './office/image-data.ts'

type ArtifactPreview =
  | OfficeAssetPreview
  | {
      name: string
      mediaType: 'image/png' | 'image/jpeg'
      contentBase64: string
      missingFonts: string[]
    }

export interface ArtifactPreviewState {
  mediaType?: string
  state: 'ready' | 'failed'
  ownerUserId: string
  sessionId: string
  sourceSha256: string
  checkedAt: string
  fileId?: string
  sha256?: string
  name?: string
  missingFonts: string[]
  error?: string
  errorStatus?: number
  quality?: RenderedQuality
}

interface PreviewRequest {
  owner: string
  sessionId: string
  artifactId: string
  file: OfficeInputFile
  signal: AbortSignal
  authorize(): Promise<unknown>
}

const diagnosticPrefix = '预览验证：'
const previewId = (request: PreviewRequest) =>
  `preview_${officeHash(JSON.stringify([request.owner, request.sessionId, request.artifactId, officeHash(request.file.content)])).slice(0, 40)}`

function pdfBytes(contentBase64: string) {
  if (
    typeof contentBase64 !== 'string' ||
    contentBase64.length > Math.ceil((16 * 1024 * 1024) / 3) * 4
  )
    throw new ApiError(413, '预览 PDF 超过大小限制')
  const bytes = Buffer.from(contentBase64, 'base64')
  if (
    bytes.toString('base64') !== contentBase64 ||
    !/^%PDF-\d\.\d/u.test(bytes.subarray(0, 8).toString('ascii')) ||
    !bytes.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')
  )
    throw new ApiError(500, '预览 PDF 内容无效，请重试')
  return bytes
}

/** Persist a derived preview; the editable artifact remains the source of truth. */
export async function renderAndCacheArtifactPreview(
  service: BusinessAgentService,
  request: PreviewRequest,
): Promise<ArtifactPreviewState> {
  const base = {
    ownerUserId: request.owner,
    sessionId: request.sessionId,
    sourceSha256: officeHash(request.file.content),
    checkedAt: utcNow(),
    missingFonts: [] as string[],
  }
  request.signal.throwIfAborted()
  try {
    const result = await (
      service.options.renderOfficePreview ?? renderOfficeAssetPreview
    )(request.file, request.signal)
    request.signal.throwIfAborted()
    await request.authorize()
    const bytes = pdfBytes(result.contentBase64)
    const quality = await renderedQuality(
      request.file,
      bytes,
      result.missingFonts,
      request.signal,
    )
    const saved = await service.options.files.save(
      request.owner,
      request.sessionId,
      result.name,
      bytes,
      'application/pdf',
      previewId(request),
    )
    request.signal.throwIfAborted()
    await request.authorize()
    return {
      ...base,
      state: 'ready',
      mediaType: 'application/pdf',
      quality,
      fileId: text(saved.fileId),
      sha256: officeHash(bytes),
      name: result.name,
      missingFonts: [
        ...new Set(
          result.missingFonts.filter((item) => typeof item === 'string'),
        ),
      ].slice(0, 100),
    }
  } catch (error) {
    // A render deadline is a failed preview. A cancelled/revoked task must not commit.
    request.signal.throwIfAborted()
    if (
      error instanceof ApiError &&
      [401, 403, 404, 499].includes(error.status)
    )
      throw error
    await request.authorize()
    return {
      ...base,
      state: 'failed',
      errorStatus: error instanceof ApiError ? error.status : 500,
      error:
        error instanceof ApiError
          ? error.message
          : '预览生成失败，请重试或下载原文件查看',
    }
  }
}

export function withArtifactPreview(
  metadata: Row,
  preview: ArtifactPreviewState,
): Row {
  const diagnostics = Array.isArray(metadata.diagnostics)
    ? metadata.diagnostics.filter(
        (item): item is string =>
          typeof item === 'string' && !item.startsWith(diagnosticPrefix),
      )
    : []
  if (preview.state === 'failed')
    diagnostics.push(
      `${diagnosticPrefix}失败，${preview.error}。可编辑文件已保留，请在成果预览入口重试；尚未通过渲染验证。`,
    )
  else if (preview.missingFonts.length)
    diagnostics.push(
      `${diagnosticPrefix}缺少字体 ${preview.missingFonts.join('、')}，PDF 使用了替代字体，请逐页检查。`,
    )
  if (preview.quality?.scope === 'spreadsheet-preview')
    diagnostics.push(
      `${diagnosticPrefix}已检查表格的 PDF 页面与边界；此检查不代表公式重算或计算结果验证。`,
    )
  if (preview.quality?.status === 'draft')
    diagnostics.push(
      ...preview.quality.issues.map((issue) => `${diagnosticPrefix}${issue}`),
      ...preview.quality.pages.flatMap((page) =>
        page.issues.map(
          (issue) => `${diagnosticPrefix}第 ${page.number} 页：${issue}`,
        ),
      ),
    )
  return {
    ...metadata,
    preview,
    quality: preview.quality,
    draft: preview.state === 'failed' || preview.quality?.status !== 'passed',
    diagnostics,
  }
}

async function cachedPreview(
  service: BusinessAgentService,
  request: PreviewRequest,
  value: unknown,
): Promise<OfficeAssetPreview | null> {
  const state = value as Partial<ArtifactPreviewState> | undefined
  if (
    !state ||
    state.state !== 'ready' ||
    state.ownerUserId !== request.owner ||
    state.sessionId !== request.sessionId ||
    state.sourceSha256 !== officeHash(request.file.content) ||
    state.fileId !== previewId(request) ||
    !state.sha256 ||
    !state.name ||
    !Array.isArray(state.missingFonts)
  )
    return null
  try {
    const cached = await service.options.files.read(
      request.sessionId,
      state.fileId,
    )
    if (
      officeHash(cached.data) !== state.sha256 ||
      cached.metadata.name !== state.name
    )
      return null
    pdfBytes(cached.data.toString('base64'))
    return {
      name: state.name,
      mediaType: 'application/pdf',
      contentBase64: cached.data.toString('base64'),
      missingFonts: state.missingFonts,
    }
  } catch {
    request.signal.throwIfAborted()
    // Derived caches may be rebuilt; never substitute a different source artifact.
    return null
  }
}

/** Read/rebuild one authorized artifact preview. The try-lock never queues work. */
export async function previewOfficeArtifact(
  service: BusinessAgentService,
  owner: string,
  sessionId: string,
  artifactId: string,
  signal: AbortSignal,
  authorize: () => Promise<unknown>,
): Promise<ArtifactPreview> {
  await authorize()
  signal.throwIfAborted()
  const lease = await service.options.db.lease(
    `artifact-preview:${sessionId}:${artifactId}`,
  )
  if (!lease)
    throw new ApiError(503, '此成果正在生成预览，请稍后重试', {
      code: 'office_preview_busy',
    })
  let lost = false
  void lease.lost.then(() => {
    lost = true
  })
  try {
    const db = service.options.db
    const [row] = await db.query(
      'SELECT metadata_json FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
      [artifactId, sessionId],
    )
    if (!row) throw new ApiError(404, '本会话成果不存在')
    const metadata = json<Row>(row.metadata_json, {})
    const stored = await service.options.files.read(sessionId, artifactId)
    if (metadata.sha256 && metadata.sha256 !== officeHash(stored.data))
      throw new ApiError(409, '成果内容已变化，不能复用原预览')
    const request: PreviewRequest = {
      owner,
      sessionId,
      artifactId,
      file: { filename: text(stored.metadata.name), content: stored.data },
      signal,
      authorize,
    }
    if (/\.(png|jpg|jpeg)$/iu.test(request.file.filename)) {
      imageData(request.file)
      signal.throwIfAborted()
      await authorize()
      return {
        name: request.file.filename,
        mediaType: /\.png$/iu.test(request.file.filename)
          ? 'image/png'
          : 'image/jpeg',
        contentBase64: stored.data.toString('base64'),
        missingFonts: [],
      }
    }
    const cached = await cachedPreview(service, request, metadata.preview)
    if (cached) {
      signal.throwIfAborted()
      await authorize()
      return cached
    }
    const preview = await renderAndCacheArtifactPreview(service, request)
    signal.throwIfAborted()
    await authorize()
    if (lost) throw new ApiError(409, '预览执行归属已失效，请重试')
    await db.query(
      'UPDATE business_agent_artifacts SET metadata_json=$3 WHERE id=$1 AND session_id=$2',
      [
        artifactId,
        sessionId,
        JSON.stringify(withArtifactPreview(metadata, preview)),
      ],
    )
    if (preview.state === 'failed')
      throw new ApiError(
        preview.errorStatus ?? 500,
        preview.error ?? '预览验证失败，请重试',
      )
    signal.throwIfAborted()
    await authorize()
    const value = await cachedPreview(service, request, preview)
    if (!value) throw new ApiError(500, '预览缓存写入未完成，请重试')
    signal.throwIfAborted()
    await authorize()
    return value
  } finally {
    await lease.release()
  }
}
