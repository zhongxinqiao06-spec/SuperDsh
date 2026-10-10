/** Renderer-safe LAN state; no server or certificate dependencies. */
export type LanHttpsIngressState = 'inactive' | 'starting' | 'ready' | 'failed'
export interface DesktopLanHttpsRuntimeSnapshot {
  readonly state: LanHttpsIngressState
  readonly actualPort: number | null
  readonly addresses: readonly string[]
  readonly caFingerprint: string | null
  readonly errorCode: string | null
}
