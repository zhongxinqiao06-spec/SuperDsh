import { request } from '@/utils/request'
import type {
  AssetDetail,
  CollectionMode,
  LibraryField,
  LibraryProjectResult,
  LibraryUpdatePreview,
} from '@/types/studio/library'
import type { StudioAsset } from '@/types/studio/studio'

const projectPath = (project: string) =>
  '/studio/projects/' + encodeURIComponent(project)
/** 收藏与引用使用明确用例及幂等键，不以同名素材推断来源。 */
export const libraryApi = {
  archive: (
    asset: string,
    body: { requestKey: string; expectedVersionId: string; archived: boolean },
  ) =>
    request<{ assetId: string; archived: boolean }>(
      '/studio/library/' + encodeURIComponent(asset) + '/archive',
      { method: 'POST', body },
    ),
  metadata: (asset: string, project?: string | null, signal?: AbortSignal) =>
    request<{ assetId: string; durationMs: number; mediaType: string }>(
      '/studio/assets/' + encodeURIComponent(asset) + '/metadata',
      { query: { project: project ?? undefined }, signal },
    ),
  detail: (asset: string, signal?: AbortSignal) =>
    request<AssetDetail>(
      '/studio/library/' + encodeURIComponent(asset) + '/detail',
      { signal },
    ),
  collect: (body: {
    sourceVersionId: string
    requestKey: string
    mode: CollectionMode
    expectedVersionId?: string
    variantName?: string
  }) =>
    request<{ asset: StudioAsset; created: boolean }>(
      '/studio/library/collections',
      { method: 'POST', body },
    ),
  import: (
    project: string,
    body: {
      sourceVersionId: string
      requestKey: string
      expectedRevision: number
    },
  ) =>
    request<LibraryProjectResult>(projectPath(project) + '/library-imports', {
      method: 'POST',
      body,
    }),
  previewUpdate: (project: string, assetId: string, signal?: AbortSignal) =>
    request<LibraryUpdatePreview>(
      projectPath(project) + '/library-updates/preview',
      { method: 'POST', body: { assetId }, signal },
    ),
  applyUpdate: (
    project: string,
    body: {
      assetId: string
      sourceVersionId: string
      expectedRevision: number
      requestKey: string
      fields: LibraryField[]
      overwriteConflicts: boolean
    },
  ) =>
    request<LibraryProjectResult>(
      projectPath(project) + '/library-updates/apply',
      { method: 'POST', body },
    ),
}
