import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import type { ExtensionViewState } from '../contracts/extension-view.ts'

export const EXTENSION_URL = 'dsh-app://compat/compatibility.html'
export const EXTENSION_ORIGIN = 'dsh-app://compat'

interface ExtensionViewsOptions {
  window(): BrowserWindow | undefined
  ready(): Promise<void>
  preload: string
  changed(state: ExtensionViewState): void
  bindBrowser(contents: WebContents): void
  openExternal(url: string): void
  warn(error: unknown): void
  createView?: (
    options: Electron.WebContentsViewConstructorOptions,
  ) => WebContentsView
}

/** Owns a separate renderer so a legacy root plugin cannot replace the product DOM. */
export class ExtensionViews {
  private view?: WebContentsView
  private owner?: BrowserWindow
  private pending?: Promise<void>
  private generation = 0
  private error?: string
  private unbind?: () => void

  constructor(private readonly options: ExtensionViewsOptions) {}

  get contents(): WebContents | undefined {
    const contents = this.view?.webContents
    return contents && !contents.isDestroyed() ? contents : undefined
  }

  state(): ExtensionViewState {
    return {
      open: this.view !== undefined,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  owns(contents: WebContents): boolean {
    return this.contents === contents
  }

  open(): Promise<void> {
    if (this.pending) return this.pending
    if (this.contents) {
      this.contents.focus()
      return Promise.resolve()
    }
    const generation = ++this.generation
    const operation = this.openView(generation)
    this.pending = operation
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined
      })
      .catch(() => {})
    return operation
  }

  private async openView(generation: number): Promise<void> {
    await this.options.ready()
    const owner = this.options.window()
    if (generation !== this.generation || !owner || owner.isDestroyed()) return
    const view = (
      this.options.createView ?? ((options) => new WebContentsView(options))
    )({
      webPreferences: {
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: true,
        webSecurity: true,
      },
    })
    this.owner = owner
    this.view = view
    this.error = undefined
    this.options.bindBrowser(view.webContents)
    owner.contentView.addChildView(view)
    const resize = (): void => {
      if (owner.isDestroyed() || this.view !== view) return
      const { width, height } = owner.getContentBounds()
      const zoom = owner.webContents.getZoomFactor()
      const toolbar = Math.min(height, Math.round(48 * zoom))
      view.setBounds({
        x: 0,
        y: toolbar,
        width,
        height: Math.max(0, height - toolbar),
      })
      view.webContents.setZoomFactor(zoom)
    }
    const close = (): void => this.close()
    const navigating = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ): void => {
      if (mainFrame && !inPlace) this.close()
    }
    owner.on('resize', resize)
    owner.on('closed', close)
    owner.webContents.on('zoom-changed', resize)
    owner.webContents.on('did-start-navigation', navigating)
    this.unbind = () => {
      owner.removeListener('resize', resize)
      owner.removeListener('closed', close)
      if (!owner.webContents.isDestroyed()) {
        owner.webContents.removeListener('zoom-changed', resize)
        owner.webContents.removeListener('did-start-navigation', navigating)
      }
    }
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.options.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(EXTENSION_URL)) {
        event.preventDefault()
        this.options.openExternal(url)
      }
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (!url.startsWith(EXTENSION_URL)) event.preventDefault()
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      this.fail(new Error(`Plugin renderer: ${details.reason}`))
    })
    resize()
    this.options.changed(this.state())
    try {
      await view.webContents.loadURL(EXTENSION_URL)
      if (this.view === view) view.webContents.focus()
    } catch (error) {
      if (this.view !== view || generation !== this.generation) return
      this.fail(error)
    }
  }

  fail(error: unknown): void {
    if (!this.view) return
    this.error = (error instanceof Error ? error.message : String(error)).slice(
      0,
      2048,
    )
    this.options.warn(error)
    this.options.changed(this.state())
  }

  /** Closing destroys the renderer, its Cordis tree, sockets and native browser leases. */
  close(): void {
    this.generation++
    const view = this.view
    const owner = this.owner
    this.view = undefined
    this.owner = undefined
    this.pending = undefined
    this.error = undefined
    this.unbind?.()
    this.unbind = undefined
    if (view) {
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed())
        view.webContents.close({ waitForBeforeUnload: false })
    }
    this.options.changed(this.state())
  }
}
