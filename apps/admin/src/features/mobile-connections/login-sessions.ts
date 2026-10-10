import type { LoginSession } from '@/features/management/api'

const mobileClientNames = new Set([
  'superdsh android',
  'agents-anywhere-mobile',
  'mobile',
])

/** Client names classify this view only; the server enforces ownership and access. */
export function isMobileLoginSession(session: LoginSession): boolean {
  return mobileClientNames.has(session.clientName.trim().toLowerCase())
}

export function mobileLoginSessions(
  sessions: readonly LoginSession[],
  now = Date.now(),
): LoginSession[] {
  return sessions
    .filter(
      (session) =>
        isMobileLoginSession(session) &&
        new Date(session.expiresAt).valueOf() > now,
    )
    .sort(
      (left, right) =>
        new Date(right.createdAt).valueOf() -
        new Date(left.createdAt).valueOf(),
    )
}
