/** Alpha.2 boot and directory-picker contracts; no generic IPC bridge. */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExtensionViewBridge,
  ExtensionViewState,
} from '../contracts/extension-view.ts'
import { IPC } from '../main/ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { syncWindowMaterial } from './preload-material.ts'
import { syncNativeLocale } from './preload-locale.ts'
import { permissionBridge } from './preload-permissions.ts'
import { onOpenSettings } from './preload-settings.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'
import { createPlatformBridge } from './preload-platform-account.ts'

if (
  location.protocol === 'dsh-app:' &&
  ['app', 'compat'].includes(location.hostname)
) {
  markDocumentPlatform()
  syncNativeTheme()
  syncNativeLocale()
  if (location.hostname === 'app') syncWindowsAppearance()
  syncWindowMaterial()
  contextBridge.exposeInMainWorld('desktopNext', {
    permissions: permissionBridge(),
    onOpenSettings,
    state: () => ipcRenderer.invoke(IPC.state),
    browserLinks: () => ipcRenderer.invoke(IPC.browserLinks),
    command: (command: unknown) => ipcRenderer.invoke(IPC.command, command),
  })
  // dsh 0.1.7 implements the native Sidebar browser itself and reads its transport from this
  // carrier; without `browser` the official plugin silently falls back to the sandboxed iframe.
  contextBridge.exposeInMainWorld('dshDesktop', {
    protocolVersion: 1,
    browser: createDesktopBrowserBridge(),
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(IPC.boot),
    failed: (message: string) => ipcRenderer.invoke(IPC.failed, message),
  })
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(IPC.directory),
  })
  if (location.hostname === 'app') {
    contextBridge.exposeInMainWorld('superdshPlatform', createPlatformBridge())
    const extensions: ExtensionViewBridge = {
      open: () => ipcRenderer.invoke(IPC.extensionOpen),
      close: () => ipcRenderer.invoke(IPC.extensionClose),
      state: () => ipcRenderer.invoke(IPC.extensionState),
      subscribe: (listener) => {
        const changed = (
          _event: Electron.IpcRendererEvent,
          state: ExtensionViewState,
        ): void => listener(state)
        ipcRenderer.on(IPC.extensionChanged, changed)
        return () => {
          ipcRenderer.removeListener(IPC.extensionChanged, changed)
        }
      },
    }
    contextBridge.exposeInMainWorld('superdshExtensions', extensions)
  }
}
