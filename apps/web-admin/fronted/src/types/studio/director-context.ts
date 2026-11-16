import type { UploadedAttachment } from '@/types/workbench/models'

/** 导演资料准备只关联已授权素材，能力状态由后端实际配置决定。 */
export interface DirectorCapability {
  available: boolean
  reason?: string
  model?: string
}
export interface DirectorCapabilities {
  vision: DirectorCapability
  research: DirectorCapability
}
export interface DirectorContextInput {
  requestKey: string
  revision: number
  assetIds: string[]
  uploads: { fileId: string; name: string }[]
  analyzeImages: boolean
  researchQuery?: string
}
export interface DirectorContextResult {
  text: string
  attachments: UploadedAttachment[]
  revision: number
  assetIds: string[]
  evidence?: DirectorEvidence
}
export interface DirectorEvidence {
  vision?: { text: string; sources: { title: string; url: string }[] }
  research?: { text: string; sources: { title: string; url: string }[] }
}
export interface DirectorUpload {
  file: UploadedAttachment
  name: string
  preview: string
}
