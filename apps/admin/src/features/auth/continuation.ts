import { consoleHash } from '@/features/console/routes'

const KEY = 'agents-anywhere.auth-continuation'
const MANAGEMENT_KEY = 'superdsh.management-continuation'
const flows = new Set([
  'mobile-oauth',
  'desktop-oauth',
  'plugin-oauth',
  'onboarding',
])

export function authFlowHash(hash: string): string | null {
  if (!hash.startsWith('#') || hash.length > 8192) return null
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  return flows.has(path) ? hash : null
}

function consoleContinuationHash(hash: string): string | null {
  const route = consoleHash(hash)
  // The bare login landing has no continuation to remember.
  return route === '#/overview' ? null : route
}

export function rememberAuthFlow(
  hash: string,
  storage: Pick<Storage, 'setItem'>,
): void {
  const flow = authFlowHash(hash)
  const management = consoleContinuationHash(hash)
  if (flow || management) {
    try {
      if (flow) storage.setItem(KEY, flow)
      else if (management) storage.setItem(MANAGEMENT_KEY, management)
    } catch {
      /* Current hash still works without storage. */
    }
  }
}

export function takeAuthFlow(
  hash: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): string | null {
  let saved: string | null = null
  let savedManagement: string | null = null
  try {
    saved = storage.getItem(KEY)
    savedManagement = storage.getItem(MANAGEMENT_KEY)
    storage.removeItem(KEY)
    storage.removeItem(MANAGEMENT_KEY)
  } catch {
    /* Storage may be blocked. */
  }
  // Device authorization and onboarding keep priority over workspace navigation.
  return (
    authFlowHash(hash) ??
    (saved ? authFlowHash(saved) : null) ??
    consoleContinuationHash(hash) ??
    (savedManagement ? consoleContinuationHash(savedManagement) : null)
  )
}

export function clearAuthFlow(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(KEY)
    storage.removeItem(MANAGEMENT_KEY)
  } catch {
    /* Best effort. */
  }
}
