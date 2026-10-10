export interface ExtensionViewState {
  open: boolean
  error?: string
}
export interface ExtensionViewBridge {
  open(): Promise<void>
  close(): Promise<void>
  state(): Promise<ExtensionViewState>
  subscribe(listener: () => void): () => void
}
declare global {
  interface Window {
    superdshExtensions?: ExtensionViewBridge
  }
}
export const OPEN_COMPATIBILITY_EVENT = 'superdsh:open-plugin-compatibility'
export async function openCompatibility(): Promise<void> {
  if (window.superdshExtensions) await window.superdshExtensions.open()
  else {
    window.open(
      '/compatibility.html?surface=standalone',
      '_blank',
      'noopener,noreferrer',
    )
    window.dispatchEvent(new Event(OPEN_COMPATIBILITY_EVENT))
  }
}
