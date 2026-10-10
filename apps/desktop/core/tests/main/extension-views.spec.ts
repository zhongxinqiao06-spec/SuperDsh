import { EventEmitter } from 'node:events'
import type {
  BrowserWindow,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: vi.fn() }))
import {
  EXTENSION_URL,
  ExtensionViews,
} from '../../src/main/extension-views.ts'

function fixture(ready: () => Promise<void> = async () => {}) {
  const contents = Object.assign(new EventEmitter(), {
    id: 20,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => {}),
    focus: vi.fn(),
    close: vi.fn(),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  })
  const view = { webContents: contents, setBounds: vi.fn() }
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    webContents: Object.assign(new EventEmitter(), {
      getZoomFactor: () => 1.25,
      isDestroyed: () => false,
    }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  })
  const createView = vi.fn(
    (_options: WebContentsViewConstructorOptions) =>
      view as unknown as WebContentsView,
  )
  const changed = vi.fn(),
    warn = vi.fn(),
    openExternal = vi.fn(),
    bindBrowser = vi.fn()
  const manager = new ExtensionViews({
    window: () => owner as unknown as BrowserWindow,
    ready,
    preload: '/product/preload.cjs',
    createView,
    changed,
    warn,
    openExternal,
    bindBrowser,
  })
  return {
    manager,
    owner,
    view,
    contents,
    createView,
    changed,
    warn,
    openExternal,
    bindBrowser,
  }
}

describe('product-owned legacy extension renderer', () => {
  it('waits for the required engine and coalesces repeated opens', async () => {
    const ready = Promise.withResolvers<void>()
    const f = fixture(() => ready.promise)
    const first = f.manager.open(),
      second = f.manager.open()
    expect(first).toBe(second)
    expect(f.createView).not.toHaveBeenCalled()
    ready.resolve()
    await first
    expect(f.createView).toHaveBeenCalledTimes(1)
    expect(f.contents.loadURL).toHaveBeenCalledWith(EXTENSION_URL)
    expect(f.manager.owns(f.contents as unknown as WebContents)).toBe(true)
    expect(f.view.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 60,
      width: 1200,
      height: 740,
    })
    expect(f.createView.mock.calls[0]?.[0].webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    })
    f.manager.close()
  })

  it('does not open a retired request after shutdown while the engine was starting', async () => {
    const ready = Promise.withResolvers<void>()
    const f = fixture(() => ready.promise)
    const opening = f.manager.open()
    f.manager.close()
    ready.resolve()
    await opening
    expect(f.createView).not.toHaveBeenCalled()
    expect(f.manager.state()).toEqual({ open: false })
  })

  it('keeps the business interface closed when the engine fails', async () => {
    const f = fixture(async () => {
      throw new Error('Harness unavailable')
    })
    await expect(f.manager.open()).rejects.toThrow('Harness unavailable')
    expect(f.manager.state()).toEqual({ open: false })
    expect(f.createView).not.toHaveBeenCalled()
  })

  it('destroys its renderer and removes owner subscriptions when closed', async () => {
    const f = fixture()
    await f.manager.open()
    expect(f.owner.listenerCount('resize')).toBe(1)
    f.manager.close()
    expect(f.contents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    })
    expect(f.owner.contentView.removeChildView).toHaveBeenCalledWith(f.view)
    expect(f.owner.listenerCount('resize')).toBe(0)
    expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
    expect(f.manager.contents).toBeUndefined()
  })

  it('closes on product reload but preserves the context across hash navigation', async () => {
    const f = fixture()
    await f.manager.open()
    f.owner.webContents.emit(
      'did-start-navigation',
      {},
      'dsh-app://app/#chat',
      true,
      true,
    )
    expect(f.manager.state().open).toBe(true)
    f.owner.webContents.emit(
      'did-start-navigation',
      {},
      'dsh-app://app/',
      false,
      true,
    )
    expect(f.manager.state().open).toBe(false)
  })

  it('contains plugin renderer failure without changing the product lifecycle', async () => {
    const f = fixture()
    await f.manager.open()
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(f.manager.state()).toEqual({
      open: true,
      error: 'Plugin renderer: crashed',
    })
    expect(f.warn).toHaveBeenCalledTimes(1)
    expect(f.owner.contentView.removeChildView).not.toHaveBeenCalled()
    f.manager.close()
  })

  it('blocks external navigation and delegates links to the product', async () => {
    const f = fixture()
    await f.manager.open()
    const event = { preventDefault: vi.fn() }
    f.contents.emit('will-navigate', event, 'https://example.com/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(f.openExternal).toHaveBeenCalledWith('https://example.com/')
    f.manager.close()
  })
})
