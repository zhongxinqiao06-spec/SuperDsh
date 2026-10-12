import type { AuthResponse, StoredSession } from '@/features/auth/types'
import { deferredAgentHeaders } from './agent-preparation'

// Access credentials stay in this document; refresh is an HttpOnly cookie.
let current: StoredSession | null = null
let revision = 0
let identityRevision = 0
let refreshing: Promise<StoredSession | null> | null = null
let signingOut: Promise<void> | null = null
const listeners = new Set<() => void>()
const SIGNED_OUT_KEY = 'superdsh.signed-out'
let signedOut = false

export function authResponseToSession(auth: AuthResponse): StoredSession {
  return {
    accessToken: auth.accessToken,
    userId: auth.userId,
    role: auth.role,
    roles: auth.roles ?? [],
    permissions: auth.permissions ?? [],
    authzVersion: auth.authzVersion ?? 0,
  }
}

export function loadStoredSession(): StoredSession | null {
  return current
}

/** Stable through token rotation; changes when the login identity is replaced. */
export function sessionIdentityRevision(): number {
  return identityRevision
}

export function saveStoredSession(session: StoredSession): void {
  if (current?.userId !== session.userId) identityRevision += 1
  signedOut = false
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(SIGNED_OUT_KEY)
    } catch {
      /* Optional state only. */
    }
  }
  revision += 1
  current = session
  discardLegacySession()
  for (const listener of listeners) listener()
}

export function clearStoredSession(): void {
  identityRevision += 1
  revision += 1
  current = null
  discardLegacySession()
  for (const listener of listeners) listener()
}

export function discardLegacySession(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem('aa.session.v1')
  } catch {
    /* Storage can be disabled. */
  }
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fence refresh immediately, then let its cookie response settle before revocation. */
export async function beginSessionSignOut(): Promise<void> {
  signedOut = true
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(SIGNED_OUT_KEY, '1')
    } catch {
      /* Memory fence remains effective. */
    }
  }
  const pending = refreshing
  clearStoredSession()
  await pending?.catch(() => undefined)
}

/** Settle the old cookie deletion before a new login can set its refresh cookie. */
export function revokeBrowserSession(
  revoke: () => Promise<unknown>,
): Promise<void> {
  if (signingOut) return signingOut
  signingOut = beginSessionSignOut()
    .then(revoke)
    .then(() => undefined)
    .finally(() => {
      signingOut = null
    })
  return signingOut
}

export async function waitForSessionSignOut(): Promise<void> {
  await signingOut?.catch(() => undefined)
  await refreshing?.catch(() => undefined)
}

/** Single flight and a revision fence prevent stale 401s or logout races. */
export function refreshSession(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredSession | null> {
  if (signedOut) return Promise.resolve(null)
  if (typeof window !== 'undefined') {
    try {
      if (window.sessionStorage.getItem(SIGNED_OUT_KEY) === '1')
        return Promise.resolve(null)
    } catch {
      /* Storage can be disabled. */
    }
  }
  if (refreshing) return refreshing
  const startedAt = revision
  refreshing = (async () => {
    const response = await fetcher(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...deferredAgentHeaders,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    })
    if (revision !== startedAt) return current
    if (response.status === 401 || response.status === 403) {
      clearStoredSession()
      return null
    }
    if (!response.ok)
      throw new Error(`Session refresh failed (${response.status})`)
    const auth = (await response.json()) as AuthResponse
    if (revision !== startedAt) return current
    if (!auth.accessToken || !auth.userId)
      throw new Error('Invalid session response')
    saveStoredSession(authResponseToSession(auth))
    return current
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}
