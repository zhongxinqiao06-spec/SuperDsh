import { useSyncExternalStore } from 'react'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'

interface WorkspaceStore {
  model: PlatformWorkspaceModel | null
  listeners: Set<() => void>
}
// Dynamic client modules share the product's single store in this renderer only.
// A compatibility renderer has its own global and never receives this authority.
const productGlobal = globalThis as typeof globalThis & {
  __SUPERDSH_PRODUCT_WORKSPACE__?: WorkspaceStore
}
const store = (productGlobal.__SUPERDSH_PRODUCT_WORKSPACE__ ??= {
  model: null,
  listeners: new Set(),
})
export function publishProductWorkspace(
  model: PlatformWorkspaceModel | null,
): void {
  store.model = model
  for (const listener of store.listeners) listener()
}
export function useProductWorkspace(): PlatformWorkspaceModel | null {
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    },
    () => store.model,
    () => null,
  )
}
