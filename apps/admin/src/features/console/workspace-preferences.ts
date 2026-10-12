'use client'

import * as React from 'react'

const STORAGE_KEY = 'aa-sidebar-show-sessions-v1'
const CHANGE_EVENT = 'superdsh:workspace-sidebar-preference'
let fallback = false

function read() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return fallback
  }
}

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener(CHANGE_EVENT, listener)
  }
}

function write(value: boolean) {
  fallback = value
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Preserve the preference in memory when storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useWorkspaceSidebarPreference(): readonly [
  boolean,
  (value: boolean) => void,
] {
  const value = React.useSyncExternalStore(subscribe, read, () => false)
  return [value, write]
}
