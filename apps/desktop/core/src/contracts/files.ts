/** File IDs are references, never authority to access the underlying content. */
export interface FileReference {
  fileId: string
  kind: 'session' | 'knowledge' | 'template' | 'artifact' | 'preview'
  resourceId: string
}

export interface FileEntry {
  id: string
  name: string
  mediaType: string
  size: number
  sha256: string
  category: 'document' | 'image' | 'audio' | 'video' | 'other'
  version: number
  previousFileId?: string
  deletedAt?: string
  createdAt: string
  references: FileReference[]
}

export interface MediaArtifact {
  fileId: string
  name: string
  mediaType: string
  sha256: string
  size: number
  preview?: { fileId: string; mediaType: string; sha256: string }
  width?: number
  height?: number
  durationSeconds?: number
  previousFileId?: string
}

export interface FileUpload {
  id: string
  state: 'receiving' | 'completing' | 'completed' | 'cancelled'
  partSize: number
  receivedParts: number[]
  expiresAt: string
  fileId?: string
}

export interface StoragePolicy {
  maxFileBytes: number
  temporaryHours: number
  recycleDays: number
}
