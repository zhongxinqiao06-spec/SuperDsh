import type { StudioAsset } from '@/types/studio/studio'

/** 分类只负责展示和选择范围，资源授权始终由后端判断。 */
export const librarySections = {
  characters: { title: '角色库', singular: '角色', kinds: ['character'] },
  scenes: { title: '场景库', singular: '场景', kinds: ['scene'] },
  props: { title: '道具库', singular: '道具', kinds: ['prop'] },
  media: {
    title: '媒体库',
    singular: '素材',
    kinds: ['image', 'video', 'audio', 'music'],
  },
} satisfies Record<
  string,
  { title: string; singular: string; kinds: StudioAsset['kind'][] }
>

export function librarySection(path: string): keyof typeof librarySections {
  if (path.endsWith('/characters')) return 'characters'
  if (path.endsWith('/environments')) return 'scenes'
  if (path.endsWith('/props')) return 'props'
  return 'media'
}

export function libraryPath(kind: StudioAsset['kind']) {
  return (
    '/entertainment/' +
    ({ character: 'characters', scene: 'environments', prop: 'props' }[
      kind as 'character' | 'scene' | 'prop'
    ] ?? 'library')
  )
}

/** 部分采用会保留本片独有修改；旧响应才回退到总版本比较。 */
export function hasLibraryUpdates(asset: StudioAsset): boolean {
  return !!(
    asset.origin &&
    (asset.origin.hasUpdates ??
      asset.origin.currentVersionId !== asset.origin.versionId)
  )
}

/** 本片默认只展示当前引用版本，避免历史造型挤占挑选空间。 */
export function currentProjectAssets(
  assets: StudioAsset[],
  linked: string[],
  kinds?: StudioAsset['kind'][],
) {
  return assets.filter(
    (asset) =>
      linked.includes(asset.id) &&
      (!kinds?.length || kinds.includes(asset.kind)),
  )
}
