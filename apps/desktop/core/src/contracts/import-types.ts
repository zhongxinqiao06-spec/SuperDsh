export type DesktopImportSource = 'desktop' | 'next'
export type DesktopImportPhase =
  'inspect' | 'backup' | 'copy' | 'profiles' | 'dependencies' | 'publish'
export interface ImportProcess {
  pid: number
  name: string
  commandLine?: string
}
export interface ImportProfile {
  name: string
  bundles: string[]
}
export interface ImportWarning {
  code: string
  message: string
  path?: string
}
export interface DesktopImportPlan {
  sourceHome: string
  targetHome: string
  source: DesktopImportSource
  profiles: ImportProfile[]
  activeProfile: string
  fileCount: number
  totalBytes: number
  skippedPaths: string[]
  warnings: ImportWarning[]
  reauthorization: readonly string[]
}
export interface DesktopImportOptions {
  sourceHome: string
  targetHome: string
  source: DesktopImportSource
  activeProfile?: string
  /** Optional Electron userData, for checking the old application's run marker. */
  sourceUserData?: string
  signal?: AbortSignal
  /** Trusted host integration seam. The default enumerates local OS processes. */
  listProcesses?: () => Promise<readonly ImportProcess[]>
  isProcessAlive?: (pid: number) => boolean
  onProgress?: (progress: {
    phase: DesktopImportPhase
    completed: number
    total: number
  }) => void
}
export interface ImportDependencyRequest {
  /** Final Home under an exclusive import lock; the backend must remain stopped. */
  home: string
  profiles: readonly { name: string; directory: string }[]
  ignoreScripts: true
  signal?: AbortSignal
}
export interface ExecuteDesktopImportOptions extends DesktopImportOptions {
  /** Install only in the supplied target, with lifecycle scripts disabled. */
  installDependencies: (request: ImportDependencyRequest) => Promise<void>
}
export interface DesktopImportResult extends DesktopImportPlan {
  transactionId: string
  backupPath: string
  receiptPath: string
}
export interface RollbackDesktopImportOptions {
  targetHome: string
  /** The caller must stop the target backend before rolling back. */
  assertTargetStopped: () => Promise<void>
  signal?: AbortSignal
}
export class DesktopImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly backupPath?: string,
  ) {
    super(message)
    this.name = 'DesktopImportError'
  }
}
