import { useEffect, useSyncExternalStore } from 'react'
import type { DesktopState } from '@superdsh/core/contracts/desktop-contract'
import type { DesktopSettingsModel } from '@superdsh/core/client/desktop-settings-model'

export function useDesktopState(
  adapter: DesktopSettingsModel,
): DesktopState | undefined {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  useEffect(() => {
    void adapter.refresh().catch(() => {})
    const timer = setInterval(() => {
      if (!document.hidden) void adapter.refresh().catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [adapter])
  return state
}
