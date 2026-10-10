/** Product-owned lifecycle of the isolated legacy plugin renderer. */
export interface ExtensionViewState {
  open: boolean
  error?: string
}

export interface ExtensionViewBridge {
  open(): Promise<void>
  close(): Promise<void>
  state(): Promise<ExtensionViewState>
  subscribe(listener: (state: ExtensionViewState) => void): () => void
}
