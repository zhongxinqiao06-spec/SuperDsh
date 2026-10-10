/** Browser view of the Host `dsh-desktop` settings namespace. */
export interface DesktopShellSettings {
  readonly mode: 'compatibility' | 'extended' | 'advanced'
  readonly macosMaterial: 'off' | 'transparent'
  readonly linuxMaterial: 'off' | 'transparent'
  readonly windowsMaterial: 'off' | 'acrylic' | 'mica'
  readonly port: number
  readonly openBrowser: boolean
  readonly networkExposure: 'loopback' | 'lan'
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Browser view of the Host `dsh-desktop-notifications` settings namespace. */
export interface DesktopNotificationSettings {
  readonly enabled: boolean
  readonly notifyOnTurnCompletion: boolean
  readonly notifyOnTurnFailure: boolean
  readonly notifyOnJobCompletion: boolean
  readonly notifyOnJobFailure: boolean
}

/** Product form contract, structurally compatible with the pinned Harness adapter. */
export interface SettingsSnapshot<T> {
  status: 'loading' | 'ready'
  value: T | undefined
  base: T | undefined
  user: Partial<T> | undefined
  revision: number | undefined
  writable: boolean
  mode: 'host'
}
export interface SettingsForm<T> {
  getSnapshot(): SettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}
