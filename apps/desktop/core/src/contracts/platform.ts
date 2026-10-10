/** Product account and remote-device contracts. Tokens never cross this boundary. */
export type PlatformJson =
  | null
  | boolean
  | number
  | string
  | PlatformJson[]
  | { [key: string]: PlatformJson }
export interface PlatformUser {
  userId: string
  username: string
  email: string | null
  displayName: string
  roles: string[]
  permissions: string[]
  authzVersion: number
  resetRequired: boolean
}
export interface PlatformAccountState {
  space: 'local' | 'platform'
  origin: string | null
  user: PlatformUser | null
  status:
    | 'signed-out'
    | 'ready'
    | 'offline'
    | 'authorizing'
    | 'authenticating'
    | 'switching'
  identityKey?: string | null
  identityGeneration?: number
  connectorId: string | null
  connectorRunning: boolean
  /** Verified server presence; a running reconnect loop alone is not online. */
  connectorOnline?: boolean
  connectorPhase?: PlatformConnectorPhase
  error: string | null
  localImportAvailable: boolean
}
export type PlatformConnectorPhase =
  | 'stopped'
  | 'preparing-python'
  | 'preparing-dependencies'
  | 'registering'
  | 'starting'
  | 'syncing'
  | 'reconnecting'
  | 'ready'
  | 'error'
export interface PlatformIdentitySnapshot {
  key: string
  generation: number
}
export interface PlatformPasswordLogin {
  origin: string
  identifier: string
  password: string
}
export interface PlatformPasswordChange {
  newPassword: string
}
export type PlatformOperation =
  | 'server-agent'
  | 'prepare-server-agent'
  | 'personal-providers'
  | 'create-personal-provider'
  | 'update-personal-provider'
  | 'delete-personal-provider'
  | 'verify-personal-provider'
  | 'personal-default'
  | 'set-personal-default'
  | 'devices'
  | 'projects'
  | 'create-project'
  | 'sessions'
  | 'runtimes'
  | 'runtime-models'
  | 'runtime-permissions'
  | 'model-catalog'
  | 'snapshot'
  | 'timeline'
  | 'events'
  | 'create-session'
  | 'send'
  | 'interrupt'
  | 'state'
  | 'capabilities'
  | 'models'
  | 'permissions'
  | 'selections'
  | 'respond'
  | 'files'
  | 'read-file'
  | 'write-file'
  | 'terminals'
  | 'create-terminal'
  | 'terminal-snapshot'
  | 'terminal-write'
  | 'terminal-resize'
  | 'terminal-close'
export interface PlatformRequest {
  identity?: PlatformIdentitySnapshot
  operation: PlatformOperation
  connectorId?: string
  runtimeId?: string
  sessionId?: string
  terminalId?: string
  noticeId?: string
  providerId?: string
  query?: Record<string, string>
  body?: PlatformJson
}
export interface PlatformEvent {
  identity?: PlatformIdentitySnapshot
  sessionId: string
  event: PlatformJson
}
export interface PlatformBridge {
  state(): Promise<PlatformAccountState>
  login(origin: string): Promise<void>
  loginWithPassword(input: PlatformPasswordLogin): Promise<void>
  changePassword(input: PlatformPasswordChange): Promise<void>
  cancelLogin(): Promise<void>
  logout(): Promise<void>
  localSpace(): Promise<void>
  connectDevice(): Promise<void>
  disconnectDevice(): Promise<void>
  importLocal(): Promise<void>
  request(request: PlatformRequest): Promise<PlatformJson>
  watch(
    sessionId: string | null,
    ownerId?: string,
    identity?: PlatformIdentitySnapshot,
  ): Promise<void>
  stopWatch(ownerId: string): Promise<void>
  subscribe(listener: (event: PlatformEvent) => void): () => void
  upload(
    sessionId: string,
    files: { name: string; type: string; data: Uint8Array }[],
    identity?: PlatformIdentitySnapshot,
  ): Promise<PlatformJson>
}
