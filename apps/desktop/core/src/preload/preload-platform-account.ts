import { ipcRenderer } from 'electron'
import type { PlatformBridge, PlatformEvent } from '../contracts/platform.ts'
import { IPC } from '../main/ipc.ts'
export function createPlatformBridge(): PlatformBridge {
  return {
    state: () => ipcRenderer.invoke(IPC.platformAccount, 'state'),
    login: (origin) => ipcRenderer.invoke(IPC.platformAccount, 'login', origin),
    loginWithPassword: (input) =>
      ipcRenderer.invoke(IPC.platformAccount, 'login-with-password', input),
    changePassword: (input) =>
      ipcRenderer.invoke(IPC.platformAccount, 'change-password', input),
    cancelLogin: () => ipcRenderer.invoke(IPC.platformAccount, 'cancel'),
    logout: () => ipcRenderer.invoke(IPC.platformAccount, 'logout'),
    localSpace: () => ipcRenderer.invoke(IPC.platformAccount, 'local'),
    connectDevice: () => ipcRenderer.invoke(IPC.platformAccount, 'connect'),
    disconnectDevice: () =>
      ipcRenderer.invoke(IPC.platformAccount, 'disconnect'),
    importLocal: () => ipcRenderer.invoke(IPC.platformAccount, 'import'),
    request: (request) => ipcRenderer.invoke(IPC.platformRemote, request),
    watch: (sessionId, ownerId, identity) =>
      ipcRenderer.invoke(IPC.platformWatch, {
        action: 'watch',
        sessionId,
        ownerId,
        identity,
      }),
    stopWatch: (ownerId) =>
      ipcRenderer.invoke(IPC.platformWatch, { action: 'stop', ownerId }),
    upload: (sessionId, files, identity) =>
      ipcRenderer.invoke(IPC.platformUpload, sessionId, files, identity),
    subscribe: (listener) => {
      const receive = (
        _event: Electron.IpcRendererEvent,
        value: PlatformEvent,
      ) => listener(value)
      ipcRenderer.on(IPC.platformEvent, receive)
      return () => ipcRenderer.removeListener(IPC.platformEvent, receive)
    },
  }
}
