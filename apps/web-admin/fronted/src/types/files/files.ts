/** 文件库元数据不提供宿主路径，引用与历史版本只按资源身份展示。 */
export interface FileEntry {
  id: string
  ownerUserId: string
  name: string
  size: number
  sha256: string
  mediaType: string
  category: string
  version: number
  previousFileId: string | null
  storageId: string
  createdAt: string
  deletedAt: string | null
  references: { fileId: string; kind: string; resourceId: string }[]
}
export interface FileList {
  items: FileEntry[]
  total: number
  page: number
  pageSize: number
}
export interface FileFilter {
  page: number
  pageSize: number
  search: string
  deleted: boolean
  category: string
}
