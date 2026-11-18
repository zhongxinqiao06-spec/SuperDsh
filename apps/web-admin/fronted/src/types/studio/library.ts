import type { StudioAsset, StudioDocument } from './studio'

/** 素材身份、造型与不可变修订分开展示，作品仅引用用户确认的版本。 */
export interface AssetDetail {
  archived: boolean
  currentVersionId: string
  asset: StudioAsset
  versions: StudioAsset[]
  variants: { id: string; name: string; currentVersionId: string }[]
  origin: StudioAsset['origin']
}
export type LibraryField = 'name' | 'description' | 'appearance' | 'voice'
export interface LibraryUpdatePreview {
  projectRevision: number
  assetId: string
  sourceVersionId: string
  baseVersionId: string
  fields: {
    key: LibraryField
    label: string
    base: unknown
    current: unknown
    incoming: unknown
    changed: boolean
    localChanged: boolean
    conflict: boolean
  }[]
  affected: {
    shots: { id: string; number: number }[]
    lines: { id: string; shotId: string }[]
  }
}
export interface LibraryProjectResult {
  revision: number
  document: StudioDocument
  assets: StudioAsset[]
  assetId: string
}
export type CollectionMode = 'new' | 'update' | 'variant'
