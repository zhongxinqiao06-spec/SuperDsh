import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc.ts'
import { permissionBridge } from './preload-permissions.ts'
import type {
  DesktopImportBridge,
  ImportProgress,
} from '../contracts/import-contract.ts'

if (location.protocol === 'dsh-app:' && location.hostname === 'shell') {
  const importer: DesktopImportBridge = {
    defaults: () => ipcRenderer.invoke(IPC.dataImport, 'defaults'),
    browse: () => ipcRenderer.invoke(IPC.dataImport, 'browse'),
    inspect: (selection) =>
      ipcRenderer.invoke(IPC.dataImport, 'inspect', selection),
    execute: (selection) =>
      ipcRenderer.invoke(IPC.dataImport, 'execute', selection),
    cancel: () => ipcRenderer.invoke(IPC.dataImport, 'cancel'),
    useImported: () => ipcRenderer.invoke(IPC.dataImport, 'use'),
    rollback: () => ipcRenderer.invoke(IPC.dataImport, 'rollback'),
    onProgress(listener) {
      const receive = (_event: unknown, value: ImportProgress) =>
        listener(value)
      ipcRenderer.on(IPC.importProgress, receive)
      return () => {
        ipcRenderer.removeListener(IPC.importProgress, receive)
      }
    },
  }
  contextBridge.exposeInMainWorld('superdshImport', importer)
  contextBridge.exposeInMainWorld('desktopNext', {
    permissions: permissionBridge(),
    state: () => ipcRenderer.invoke(IPC.state),
    browserLinks: () => ipcRenderer.invoke(IPC.browserLinks),
    command: (command: unknown) => ipcRenderer.invoke(IPC.command, command),
  })
}
