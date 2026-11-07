export type {
  OfficeSource,
  OfficePlan,
  ArtifactRevision,
} from '@superdsh/core/contracts/office'

export interface OfficeConfirmation {
  planId: string
  version: number
  sha256: string
  /** Host-only challenge, never returned by a browser route or model tool result. */
  token: string
}
