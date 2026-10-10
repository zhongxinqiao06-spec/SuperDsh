/** Revocation may originate inside the connection operation being retired. */
export interface PlatformIdentityCleanup {
  invalidate(): void
  closeRemote(): Promise<void>
  stopConnector(): Promise<void>
  refresh(): Promise<void>
  report(error: unknown): void
}

/** Capture and retire old resources immediately, without self-waiting in token refresh. */
export function cleanupExpiredPlatformIdentity(
  options: PlatformIdentityCleanup,
): void {
  options.invalidate()
  const invoke = (operation: () => Promise<void>): Promise<void> => {
    try {
      return operation()
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const remote = invoke(options.closeRemote)
  const connector = invoke(options.stopConnector)
  void Promise.all([remote, connector])
    .then(options.refresh)
    .catch(options.report)
}
