import { useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import { loadStoredSession, subscribeSession } from '@/features/auth/session'

type Cell<T> = {
  get: () => T
  set: (next: SetStateAction<T>) => void
  subscribe: (listener: () => void) => () => void
  current: () => boolean
}

let owner = loadStoredSession()?.userId ?? null
let generation = 0
const cells = new Map<string, Cell<unknown>>()

function revokePreviews(value: unknown, seen = new Set<object>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const key of ['preview', 'previewUrl']) {
    const preview = (value as Record<string, unknown>)[key]
    if (typeof preview === 'string' && preview.startsWith('blob:'))
      URL.revokeObjectURL(preview)
  }
  for (const child of Object.values(value)) revokePreviews(child, seen)
}

// This listener has no network activity. It invalidates old closures even when
// the workbench is unmounted, including logout followed by the same account.
subscribeSession(() => {
  const next = loadStoredSession()?.userId ?? null
  if (next === owner) return
  owner = next
  generation += 1
  for (const cell of cells.values()) revokePreviews(cell.get())
  cells.clear()
})

export function workbenchCell<T>(key: string, initial: T | (() => T)): Cell<T> {
  const existing = cells.get(key)
  if (existing) return existing as Cell<T>
  const started = generation
  let value = typeof initial === 'function' ? (initial as () => T)() : initial
  const listeners = new Set<() => void>()
  const cell: Cell<T> = {
    get: () => value,
    current: () => started === generation,
    set: (next) => {
      if (started !== generation) return
      const updated =
        typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      if (Object.is(value, updated)) return
      value = updated
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  cells.set(key, cell as Cell<unknown>)
  return cell
}

/** Preserve follow-up drafts and upload closures when creation resolves its ID. */
export function migrateWorkbenchSession(from: string, to: string) {
  if (from === to) return
  const prefix = `session/${from}/`
  for (const [key, cell] of [...cells]) {
    if (!key.startsWith(prefix)) continue
    const targetKey = `session/${to}/${key.slice(prefix.length)}`
    if (cells.has(targetKey)) continue
    const value = cell.get()
    if (
      value &&
      typeof value === 'object' &&
      'sessionId' in value &&
      value.sessionId === from
    ) {
      cell.set({ ...value, sessionId: to })
    }
    cells.set(targetKey, cell)
  }
}

/** Document-memory state only: no credentials or files are written to storage. */
export function useWorkbenchState<T>(key: string, initial: T | (() => T)) {
  const session = useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  const scope = session?.userId ?? null
  // Cells and their setters survive module unmount; identity changes fence them.
  const cell = useMemo(() => workbenchCell(key, initial), [key, scope])
  const value = useSyncExternalStore(cell.subscribe, cell.get, cell.get)
  return [value, cell.set] as const
}
