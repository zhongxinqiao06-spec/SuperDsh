import type {
  DesktopImportPlan,
  DesktopImportResult,
  DesktopImportSource,
} from './import-types.ts'

export interface ImportSelection {
  source: DesktopImportSource
  sourceHome: string
  targetHome: string
}
export interface ImportDefaults {
  desktopHome: string
  nextHome: string
  targetHome: string
  selection?: ImportSelection
  plan?: DesktopImportPlan
  result?: DesktopImportResult
  error?: string
}
export interface ImportProgress {
  phase: string
  completed: number
  total: number
}
export interface DesktopImportBridge {
  defaults(): Promise<ImportDefaults>
  browse(): Promise<string | null>
  inspect(selection: ImportSelection): Promise<DesktopImportPlan>
  execute(selection: ImportSelection): Promise<DesktopImportResult>
  cancel(): Promise<void>
  useImported(): Promise<void>
  rollback(): Promise<void>
  onProgress(listener: (progress: ImportProgress) => void): () => void
}
declare global {
  interface Window {
    superdshImport?: DesktopImportBridge
  }
}
