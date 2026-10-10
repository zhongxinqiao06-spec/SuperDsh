import { createShutdownCoordinator } from '../application/shutdown.ts'
import { PlatformSpaces } from './platform-spaces.ts'
import { PlatformModelGateway } from './platform-model-gateway.ts'
import { PlatformAccount } from './platform-account.ts'
import { PlatformConnector } from './platform-connector.ts'
import { PlatformRemote } from './platform-remote.ts'
import { cleanupExpiredPlatformIdentity } from '../application/platform-identity-cleanup.ts'
import type {
  PlatformIdentitySnapshot,
  PlatformRequest,
} from '../contracts/platform.ts'
/** Official alpha.2 Desktop transport with a Host-independent native shell. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import {
  appRequestHeaders,
  forwardWebRequest,
  serveWebDocument,
} from './web-document.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import {
  HARNESS_PACKAGE,
  NEXT_PACKAGE,
  parseFeatures,
  profileName,
} from './profiles.ts'
import { APP_URL, IPC, SHELL_URL } from './ipc.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
import { preferredDesktopLocale, resolveDesktopLocale } from './menu-locale.ts'
import { NativeLocaleStore } from './native-locale.ts'
import { NextDesktopRuntime } from '../backend/desktop-runtime.ts'
import {
  probeSystemProxy,
  type DesktopSystemProxyProbe,
} from '../backend/system-proxy.ts'
import {
  DEFAULT_PROFILE,
  NATIVE_ACCESS_HEADER,
  type DesktopCommand,
  type DesktopState,
  type DesktopSettingsPage,
} from '../contracts/desktop-contract.ts'
import {
  portsChanged,
  parsePreferences,
} from '../backend/desktop-preferences.ts'
import { NativeDesktop, applyWindowMaterial } from './native-desktop.ts'
import { desktopLanAddresses } from './lan-addresses.ts'
import {
  createLanHttpsCertificate,
  lanHttpsCertificateDiagnostic,
} from '../backend/lan-https-certificate.ts'
import {
  desktopTerminalStateDirectory,
  openDesktopTerminal,
} from './desktop-terminal.ts'
import { bundledPnpmEntry } from './extensions.ts'
import { applyDesktopPackageAgePolicy } from './pnpm-policy.ts'
import {
  auxiliaryWindowChromeOptions,
  auxiliaryWindowHasCustomFrame,
} from '../platform/shared/auxiliary-window-options.ts'
import { atomicJson, privateDirectory } from '../backend/private-files.ts'
import { supportsMica, windowMaterial } from './window-material.ts'
import {
  ONBOARDING_ARGUMENT,
  RECOVERY_ARGUMENT,
  SAFE_ARGUMENT,
  relaunchArguments,
} from './relaunch.ts'
import {
  createNativePermissions,
  installMediaPermissions,
} from './electron-permissions.ts'
import { readDataDirectory } from './data-directory.ts'
import { maskSecrets } from '../backend/mask-secrets.ts'
import { DesktopBrowserGuests } from './browser-guests.ts'
import { PlatformLoginWindow } from './platform-login-window.ts'
import { NextUpdates } from './updates.ts'
import { NextUpdateInstaller } from './update-installer.ts'
import { updateLabel } from '../contracts/update-state.ts'
import { DesktopDataImport } from './data-import.ts'
import { installProfileDependencies } from '@superdsh/core/backend/profile-install'
import { assertImportSourceStopped } from '@superdsh/core/backend/import'
import { startFrontendDevelopment } from './frontend-development.ts'
import { desktopRuntimeAssets } from './installation.ts'
import { createRecoveryActions } from './recovery-actions.ts'
import {
  ExtensionViews,
  EXTENSION_ORIGIN,
  EXTENSION_URL,
} from './extension-views.ts'

// Inherit the package policy across the Host and every runtime child process.
applyDesktopPackageAgePolicy(process.env)

const root = dirname(NEXT_PACKAGE)
const defaultHome = resolve(
  process.env.SUPERDSH_HOME ??
    (app.isPackaged
      ? join(app.getPath('appData'), 'SuperDsh', 'home')
      : join(root, '../../.superdsh', 'home')),
)
const locationFile = join(defaultHome, 'desktop-next-location.json')
const dataLocation = readDataDirectory(defaultHome)
const accountSpaces = new PlatformSpaces(defaultHome, dataLocation.home)
// Platform identity never changes the product's local history or personal credentials.
const home = resolve(dataLocation.home)
const nativeLocale = new NativeLocaleStore(home)
const electronData = join(home, 'electron-user-data')
privateDirectory(electronData)
app.setName('SuperDsh')
app.setPath('userData', electronData)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let mainWindow: BrowserWindow | undefined
// Storage partitions outlive individual windows, so the guest owner is process-scoped.
const browserGuests = new DesktopBrowserGuests(() =>
  runtime.auth ? [new URL(runtime.auth.url).origin] : [],
)
let shellWindow: BrowserWindow | undefined
let replacingWindow = false
let diagnosticsFile: string | undefined
let recoveryNotice: NonNullable<DesktopState['recovery']>['notice']
let recoveryStopping: Promise<void> = Promise.resolve()
let pendingSettings: DesktopSettingsPage | undefined
let quitting = false
let onboarding = false
let onboardingComputerUse = false
let relaunch: string[] | undefined
let installingUpdate = false
let systemProxy: DesktopSystemProxyProbe = {}
let ownsInstance = false
let windowsLanguage = 'en'
const require = createRequire(NEXT_PACKAGE)
const runtimeAssets = desktopRuntimeAssets(NEXT_PACKAGE)
const webRoot = dirname(runtimeAssets.frontendIndex)
const version = (
  JSON.parse(readFileSync(NEXT_PACKAGE, 'utf8')) as { version: string }
).version
const t = (zh: string, en: string): string =>
  windowsLanguage.toLowerCase().startsWith('zh') ? zh : en
const runtime = new NextDesktopRuntime({
  home,
  managedPlatform: true,
  modelGateway: () => managedModels.descriptor(),
  root,
  executable: process.execPath,
  frontendManifest: runtimeAssets.frontendManifest,
  addresses: () => [...desktopLanAddresses()],
  systemProxy: () => systemProxy,
  certificate: async (addresses) => {
    try {
      return await createLanHttpsCertificate(electronData, addresses, {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        seal: (bytes) =>
          safeStorage.encryptString(Buffer.from(bytes).toString('utf8')),
        open: (bytes) =>
          Buffer.from(safeStorage.decryptString(Buffer.from(bytes)), 'utf8'),
      })
    } catch (error) {
      runtime.diagnostics.append(lanHttpsCertificateDiagnostic(error), 'warn')
      throw error
    }
  },
  onFailure: () => {
    if (app.isReady()) openControls('recovery')
  },
  onChange: () => {
    if (app.isReady()) native.refresh()
  },
  onRestart: () => run({ type: 'restart' }),
  onTerminal: () => run({ type: 'terminal' }),
  onNotification: (notification) => native.notify(notification),
  onPlatformLogin: (request) => {
    if (quitting || !app.isReady()) return
    if (request.action === 'close') {
      platformLogin.close()
      if (request.focus) openMain()
      return
    }
    const url = platformLoginUrl(request.url)
    // A system browser reaches the Host's loopback callback only while browser access is on;
    // otherwise the built-in window replays the callback with the native credentials.
    if (runtime.state().browserUrl !== null) {
      void shell
        .openExternal(url)
        .catch((error) => runtime.diagnostics.append(String(error), 'warn'))
    } else platformLogin.open(url)
  },
  onPermission: async (action, permission) => {
    if (quitting) throw new Error('Desktop is shutting down')
    const snapshot = permissions.query(permission)
    // Host calls reveal the permission dialog on every platform; only a user click there may prompt
    // the OS. Platforms without an OS request or settings shortcut still receive the dialog, which
    // reports the current status, because silence would leave the request without any visible answer.
    if (
      action === 'open-settings' ||
      (action === 'request' && snapshot.status !== 'granted')
    ) {
      openSettings('permissions')
    }
    return snapshot
  },
})
const accountSecrets = {
  isEncryptionAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' ||
      safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value),
}
const managedAccount = new PlatformAccount(
  accountSpaces,
  accountSecrets,
  (url) => shell.openExternal(url),
  {
    beforeActivate: async (previous, next) => {
      if (quitting) throw new Error('SuperDsh is shutting down')
      if (previous?.key && previous.key === next?.key) return true
      if (previous && (await runtime.platformTasks('inspect'))) {
        const proceed = await confirmed(
          t(
            '停止当前任务并切换平台账号？',
            'Stop active tasks and change platform account?',
          ),
          t(
            '本地聊天和配置会保留，应用与 Harness 不会重新启动。取消后继续使用原账号。',
            'Local history and settings stay in place. The app and Harness stay running. Cancel to keep the current account.',
          ),
        )
        if (!proceed) return false
        await runtime.platformTasks('stop')
      }
      await managedRemote.close()
      await managedConnector.stop()
      managedModels.invalidateIdentity()
      return true
    },
    onActivated: async () => {
      // Native sign-in completes independently of Python preparation and device sync.
      if (!managedAccount.state().user) {
        cleanupExpiredPlatformIdentity({
          invalidate: () => managedModels.invalidateIdentity(),
          closeRemote: () => managedRemote.close(),
          stopConnector: () => managedConnector.stop(),
          refresh: refreshPlatformConnection,
          report: (error) =>
            runtime.diagnostics.append(maskSecrets(String(error)), 'warn'),
        })
        return
      }
      void refreshPlatformConnection()
    },
  },
)
const managedConnector = new PlatformConnector(
  managedAccount,
  home,
  accountSecrets,
  { diagnostic: (message) => runtime.diagnostics.append(message, 'info') },
)
const managedModels = new PlatformModelGateway(
  managedAccount,
  () => managedConnector.state().connectorId,
)
const managedRemote = new PlatformRemote(managedAccount, (value) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC.platformEvent, value)
})
async function refreshPlatformConnection(): Promise<void> {
  // A platform failure changes its connection indicator, never the native Host state.
  if (quitting || runtime.safeMode || runtime.recoveryMode) return
  const refreshModels = () =>
    runtime.refreshPlatformModels().catch((error: unknown) => {
      runtime.diagnostics.append(maskSecrets(String(error)), 'warn')
    })
  try {
    await runtime.startup
    if (quitting || runtime.safeMode || runtime.recoveryMode) return
    await refreshModels()
    if (managedAccount.state().user && !managedAccount.user.resetRequired)
      await managedConnector.connect()
    await refreshModels()
  } catch (error) {
    runtime.diagnostics.append(maskSecrets(String(error)), 'warn')
  }
}
const recoveryActions = createRecoveryActions({
  accountSpace: false,
  runtime,
  home,
  defaultHome,
  locationFile,
  t,
  confirmed,
  openPath,
  raiseDialogOwner,
  diagnosticsFile: () => diagnosticsFile,
  waitForStop: () => recoveryStopping,
  notice: (value) => {
    recoveryNotice = value
  },
  relaunch: () => {
    relaunch = relaunchArguments(process.argv.slice(1), false, false)
    app.quit()
  },
})
const extensions = new ExtensionViews({
  window: () => mainWindow,
  preload: require.resolve('@superdsh/core/preload/preload-extension'),
  ready: async () => {
    await runtime.startup
    if (
      quitting ||
      runtime.state().phase !== 'ready' ||
      !runtime.backend.host ||
      !runtime.auth
    ) {
      throw new Error('Harness must be ready before opening plugin interfaces')
    }
  },
  bindBrowser: (webContents) => browserGuests.bind({ webContents }),
  changed: (value) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(IPC.extensionChanged, value)
  },
  openExternal: (value) => {
    try {
      if (['https:', 'http:', 'mailto:'].includes(new URL(value).protocol)) {
        void shell
          .openExternal(value)
          .catch((error) => runtime.diagnostics.append(String(error), 'warn'))
      }
    } catch {
      /* Malformed external URLs are not navigations. */
    }
  },
  warn: (error) =>
    runtime.diagnostics.append(maskSecrets(String(error)), 'warn'),
})
const platformLogin = new PlatformLoginWindow({
  BrowserWindow,
  session: (partition) => session.fromPartition(partition),
  host: () => runtime.auth,
  parent: () => mainWindow,
  title: () => t('登录 DeepSeek', 'Sign in to DeepSeek'),
  dark: () => nativeTheme.shouldUseDarkColors,
  warn: (error) => runtime.diagnostics.append(String(error), 'warn'),
})
const native = new NativeDesktop({
  root,
  language: () => windowsLanguage,
  state,
  window: () => mainWindow,
  show: openMain,
  run,
  warn: (error) => runtime.diagnostics.append(String(error), 'warn'),
})
const permissions = createNativePermissions()
const updateInstaller = new NextUpdateInstaller({
  platform: process.platform,
  executable: process.execPath,
  log: (error) => runtime.diagnostics.append(String(error), 'warn'),
})
const updates = new NextUpdates({
  version,
  platform: process.platform,
  packaged: app.isPackaged,
  userData: electronData,
  request: (url, init) => net.fetch(url, { ...init, credentials: 'omit' }),
  changed: () => {
    if (app.isReady() && !quitting) native.refresh()
  },
  log: (error) => runtime.diagnostics.append(String(error), 'warn'),
  prepare: (path, nextVersion, directory, signal) =>
    updateInstaller.prepare(path, nextVersion, directory, signal),
  install: async () => {
    runtime.busy = true
    native.refresh()
    try {
      await updateInstaller.stage()
      if (!quitting) {
        installingUpdate = true
        app.quit()
      }
    } finally {
      runtime.busy = false
      if (!quitting) native.refresh()
    }
  },
})

const dataImport = new DesktopDataImport({
  defaultHome,
  currentHome: home,
  desktopHome: join(homedir(), '.dsh'),
  nextHome: existsSync(
    resolve(root, '../../dsh-desktop-next/.desktop-next/home'),
  )
    ? resolve(root, '../../dsh-desktop-next/.desktop-next/home')
    : join(app.getPath('appData'), 'DSH NEXT', 'home'),
  browse: async () => {
    const selected = await dialog.showOpenDialog({
      title: t(
        '选择旧桌面的数据目录',
        'Select the previous desktop data directory',
      ),
      properties: ['openDirectory'],
    })
    return selected.canceled ? null : (selected.filePaths[0] ?? null)
  },
  stopBackend: async () => {
    // A starting child has no public host yet, but its interrupted startup
    // still needs resuming after the independent import transaction settles.
    const restart =
      !onboarding &&
      !runtime.recoveryMode &&
      ['starting', 'ready'].includes(runtime.backend.state.phase)
    runtime.busy = true
    native.refresh()
    try {
      await runtime.backend.stop()
    } catch (error) {
      runtime.busy = false
      native.refresh()
      throw error
    }
    return async () => {
      runtime.busy = false
      if (restart && !quitting && !runtime.recoveryMode)
        await runtime.start().catch((error) => runtime.report(error))
      if (!quitting) native.refresh()
    }
  },
  installDependencies: installProfileDependencies,
  assertTargetStopped: async (targetHome) => {
    if (resolve(targetHome) === resolve(home))
      throw new Error('当前应用正在使用此数据目录')
    await assertImportSourceStopped({
      source: 'next',
      sourceHome: targetHome,
      targetHome,
    })
  },
  activate: async (targetHome) => {
    atomicJson(locationFile, { home: targetHome })
    relaunch = relaunchArguments(process.argv.slice(1), false, false)
    app.quit()
  },
  progress: (value) => {
    if (shellWindow && !shellWindow.isDestroyed())
      shellWindow.webContents.send(IPC.importProgress, value)
  },
})

const frontendDevelopment = startFrontendDevelopment({
  manifestPath: runtimeAssets.frontendManifest,
  refresh: async (signal) => {
    if (quitting || signal.aborted || runtime.closing) return
    if (!app.isReady() || runtime.busy || dataImport.busy) return false
    // Inactive modes load the current manifest on their next explicit start; never revive a stopped Host.
    if (
      onboarding ||
      runtime.recoveryMode ||
      runtime.backend.state.phase === 'error'
    )
      return
    if (runtime.backend.state.phase !== 'ready' || !runtime.backend.host)
      return false
    runtime.busy = true
    native.refresh()
    try {
      await runtime.restart(() => {
        if (quitting || signal.aborted || runtime.closing)
          throw new Error('Frontend refresh cancelled during shutdown')
      })
      if (
        !quitting &&
        !signal.aborted &&
        mainWindow &&
        !mainWindow.isDestroyed()
      )
        await reloadMain()
    } finally {
      runtime.busy = false
      if (!quitting) native.refresh()
    }
  },
  onError: (error) => runtime.diagnostics.append(String(error), 'error'),
})

function state(): DesktopState {
  let recovery: DesktopState['recovery']
  try {
    recovery = {
      bundles: [],
      checkpoints: runtime.recovery.checkpoints(runtime.selected),
      profileDirectory: runtime.profiles.directory(runtime.selected),
      usingDefaultDirectory: home === defaultHome,
      diagnosticsFile,
      notice: recoveryNotice,
    }
    try {
      recovery.bundles = runtime.recovery.bundles(runtime.selected)
    } catch (error) {
      recovery.error = String(error)
    }
  } catch (error) {
    recovery = {
      bundles: [],
      checkpoints: [],
      profileDirectory: join(home, 'profiles', runtime.selected),
      usingDefaultDirectory: home === defaultHome,
      error: String(error),
      diagnosticsFile,
      notice: recoveryNotice,
    }
  }
  return {
    ...runtime.state(),
    recovery,
    onboarding,
    ...(onboarding ? { onboardingComputerUse } : {}),
    platform: process.platform,
    version,
    updates: updates.snapshot(),
    trayAvailable: native.available,
    notificationsAvailable: Notification.isSupported(),
    windowsMicaSupported: process.platform === 'win32' && supportsMica(),
  }
}
function run(value: DesktopCommand): void {
  void command(value, 'native').catch((error) => runtime.report(error))
}

function assertSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  owner: BrowserWindow | undefined,
  origin: string,
): void {
  if (
    !owner ||
    owner.isDestroyed() ||
    event.sender !== owner.webContents ||
    event.senderFrame !== owner.webContents.mainFrame ||
    !event.senderFrame.url.startsWith(origin)
  )
    throw new Error('Rejected Next IPC sender')
}
function assertDesktopSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): void {
  if (event.sender === mainWindow?.webContents)
    assertSender(event, mainWindow, APP_URL)
  else if (extensions.owns(event.sender)) assertApplicationSender(event)
  else assertSender(event, shellWindow, 'dsh-app://shell/')
}
function assertApplicationSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): void {
  if (!extensions.owns(event.sender))
    return assertSender(event, mainWindow, APP_URL)
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame.url.startsWith(EXTENSION_URL)
  ) {
    throw new Error('Rejected plugin renderer IPC sender')
  }
}
/**
 * Carry the effective palette into the Platform login page, as upstream Desktop does.
 * `system` resolves through `nativeTheme.shouldUseDarkColors`, which follows the theme
 * source preload-theme.ts publishes.
 * @param authorizeUrl - authorization URL already validated by host-process.ts.
 * @returns the URL carrying `theme=light` or `theme=dark`.
 */
function platformLoginUrl(authorizeUrl: string): string {
  const url = new URL(authorizeUrl)
  url.searchParams.set(
    'theme',
    nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  )
  return url.href
}
function show(window: BrowserWindow): void {
  if (quitting || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createWindow(preload: string, primary = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 580,
    show: false,
    title: 'SuperDsh',
    ...(process.platform !== 'darwin'
      ? {
          icon: join(
            root,
            'build',
            process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png',
          ),
        }
      : {}),
    ...(!primary ? auxiliaryWindowChromeOptions() : {}),
    ...(process.platform === 'win32' && primary
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            height: WINDOWS_TITLEBAR_HEIGHT,
            color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
            symbolColor: nativeTheme.shouldUseDarkColors
              ? '#f9fafb'
              : '#0f1115',
          },
        }
      : {}),
    ...(process.platform === 'darwin' && primary
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy:
            runtime.preferences.macosMaterial === 'transparent'
              ? ('sidebar' as const)
              : undefined,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {}),
    // `webviewTag` only on the application document: every attachment is still refused unless
    // `DesktopBrowserGuests` issued the lease, and the guest itself never gets the tag.
    webPreferences: {
      preload: require.resolve(
        '@superdsh/core/preload/' + preload.replace(/\.cjs$/, ''),
      ),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: primary,
    },
  })
  window.once('ready-to-show', () => show(window))
  if (primary) {
    applyWindowMaterial(window, runtime.preferences)
    window.webContents.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key === ',' &&
        (input.control || input.meta) &&
        !input.alt
      ) {
        event.preventDefault()
        openControls()
      }
    })
    window.on('close', (event) => {
      if (!quitting && runtime.preferences.closeToTray && native.available) {
        event.preventDefault()
        window.hide()
      } else if (!quitting) {
        event.preventDefault()
        app.quit()
      }
    })
  }
  const openExternal = (url: string): void => {
    try {
      if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol))
        void shell.openExternal(url).catch((error) => runtime.report(error))
    } catch {
      /* Ignore malformed external links. */
    }
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(primary ? APP_URL : SHELL_URL)) {
      event.preventDefault()
      openExternal(url)
    }
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!url.startsWith(primary ? APP_URL : SHELL_URL)) event.preventDefault()
  })
  return window
}

function openSettings(page: DesktopSettingsPage = 'general'): void {
  if (quitting) return
  if (onboarding) {
    openControls('onboarding')
    return
  }
  if (runtime.recoveryMode || runtime.state().phase === 'error') {
    openControls('recovery')
    return
  }
  pendingSettings = page
  openMain()
  mainWindow?.webContents.send(IPC.settingsOpen)
}

function openControls(
  page:
    | 'general'
    | 'profiles'
    | 'create-profile'
    | 'tools'
    | 'recovery'
    | 'permissions'
    | 'onboarding'
    | 'import' = 'general',
): void {
  if (quitting) return
  if (page === 'general' || page === 'tools' || page === 'permissions') {
    openSettings(page === 'permissions' ? 'permissions' : 'general')
    return
  }
  if (page === 'recovery' && !runtime.safeMode && !runtime.recoveryMode) {
    runtime.recoveryMode = true
    onboarding = false
    // Destroy bypasses the normal close-to-tray/app-quit handler.
    const previousMain = mainWindow
    mainWindow = undefined
    replacingWindow = true
    try {
      previousMain?.destroy()
    } finally {
      replacingWindow = false
    }
    recoveryStopping = runtime.backend.stop()
    void recoveryStopping.catch((error) =>
      runtime.diagnostics.append(String(error), 'error'),
    )
    native.refresh()
  }
  const locale = nativeLocale.resolve(runtime.selected, windowsLanguage)
  windowsLanguage = locale
  const url = `${SHELL_URL}?locale=${locale}&platform=${process.platform}&frame=${auxiliaryWindowHasCustomFrame()}#${page}`
  const resize = (window: BrowserWindow): void => {
    const creating = page === 'create-profile'
    window.setResizable(!creating)
    window.setMinimumSize(creating ? 420 : 680, creating ? 330 : 560)
    window.setSize(
      creating ? 480 : page === 'onboarding' ? 1040 : 850,
      creating ? 360 : page === 'onboarding' ? 720 : 800,
    )
  }
  if (shellWindow && !shellWindow.isDestroyed()) {
    // Dock/tray activation must not reset an unfinished wizard or its selections.
    if (page === 'onboarding' && shellWindow.webContents.getURL() === url) {
      show(shellWindow)
      return
    }
    resize(shellWindow)
    void shellWindow
      .loadURL(url)
      .catch((error) => runtime.diagnostics.append(String(error), 'error'))
    show(shellWindow)
    return
  }
  shellWindow = createWindow('preload-shell.cjs')
  resize(shellWindow)
  shellWindow.on('closed', () => {
    shellWindow = undefined
    void dataImport.close()
  })
  void shellWindow
    .loadURL(url)
    .catch((error) => runtime.diagnostics.append(String(error), 'error'))
}
function openMain(): void {
  if (quitting) return
  if (runtime.recoveryMode || runtime.state().phase === 'error') {
    openControls('recovery')
    return
  }
  if (onboarding) {
    openControls('onboarding')
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    show(mainWindow)
    return
  }
  mainWindow = createWindow('preload-app.cjs', true)
  const owner = mainWindow
  // The guest owner installs its own navigation, crash and destruction release paths.
  browserGuests.bind(owner)
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) runtime.report(new Error(`Renderer: ${details.reason}`))
  })
  mainWindow.webContents.on('preload-error', (_event, _path, error) =>
    runtime.report(error),
  )
  // The Host log otherwise misses client slot failures: the renderer can retire
  // an entry (and its portalled dialog) without crashing the Electron process.
  mainWindow.webContents.on(
    'console-message',
    (event, _level, legacyMessage) => {
      // Electron versions differ: older runtimes pass the message as the third
      // argument, newer ones put it on the event. Never assume either exists.
      const message =
        typeof legacyMessage === 'string' ? legacyMessage : event?.message
      if (typeof message !== 'string') return
      if (
        !message.includes('[next-ui-diagnostic]') &&
        !message.includes('slot entry crashed') &&
        !message.includes('client-modules:') &&
        !message.includes('slot factory occurrence crashed')
      )
        return
      runtime.diagnostics.append(maskSecrets(message.slice(0, 2048)), 'warn')
    },
  )
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, code, message, _url, isMain) => {
      if (
        isMain &&
        code !== -3 &&
        !quitting &&
        mainWindow === owner &&
        !owner.isDestroyed()
      )
        runtime.report(new Error(message))
    },
  )
  void loadMainDocument(owner).catch((error) => runtime.report(error))
}
/** Cancelled or retired window navigations are not Host failures. */
async function loadMainDocument(owner: BrowserWindow): Promise<void> {
  try {
    await owner.loadURL(APP_URL)
  } catch (error) {
    if (quitting || owner.isDestroyed() || mainWindow !== owner) return
    const failure = error as { code?: string; errno?: number }
    if (failure?.code === 'ERR_ABORTED' || failure?.errno === -3) return
    throw error
  }
}

async function reloadMain(): Promise<void> {
  const existing = mainWindow
  openMain()
  // A newly created window already started its first navigation in openMain().
  if (existing && existing === mainWindow && !existing.isDestroyed())
    await loadMainDocument(existing)
}

/**
 * Raise the window a modal dialog must belong to, and return it as its owner.
 *
 * Electron's `dialog.*` overloads that take no `BrowserWindow` open an unowned
 * top-level window. On Windows that window disables nothing and is ordered
 * against every other top-level window, so one click on the app sends the
 * prompt behind it leaving no taskbar hint and no visual trace. Every recovery
 * action waits on `confirmed()` before it touches a single file, so an occluded
 * prompt is indistinguishable from an action that hung forever: no file change,
 * no diagnostic line, no error, and no timeout to end it. Owning the dialog
 * makes it window-modal, which is what the recovery UI's own busy state already
 * promises the user.
 *
 * Recovery, safe mode and onboarding all run in `shellWindow` while
 * `mainWindow` is destroyed, and `shellWindow` is only open while the user is
 * looking at it, so preferring it puts the prompt on the surface that raised it.
 *
 * @returns the owning window, or `undefined` when no window is alive and an
 *   unowned dialog is the only thing left.
 */
function raiseDialogOwner(): BrowserWindow | undefined {
  for (const window of [shellWindow, mainWindow]) {
    if (window === undefined || window.isDestroyed()) continue
    show(window)
    return window
  }
  return undefined
}

async function confirmed(
  message: string,
  detail = t(
    '将停止当前 Host，正在运行的任务会被中断。',
    'This stops the current Host and interrupts running tasks.',
  ),
): Promise<boolean> {
  const owner = raiseDialogOwner()
  const options = {
    type: 'question' as const,
    title: 'SuperDsh',
    message,
    detail,
    buttons: [t('继续', 'Continue'), t('取消', 'Cancel')],
    defaultId: 1,
    cancelId: 1,
  }
  const result = await (owner === undefined
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(owner, options))
  return result.response === 0 && !quitting
}
async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

async function command(
  value: unknown,
  source: 'app' | 'shell' | 'native' = 'app',
): Promise<void> {
  if (!value || typeof value !== 'object' || !('type' in value))
    throw new Error('Invalid Next command')
  const input = value as Record<string, unknown>
  const type = input.type
  if (typeof type !== 'string') throw new Error('Invalid Next command')
  if (type === 'controls') {
    if (
      input.page !== undefined &&
      (typeof input.page !== 'string' ||
        ![
          'general',
          'profiles',
          'create-profile',
          'tools',
          'recovery',
          'permissions',
          'import',
        ].includes(input.page))
    )
      throw new Error('Invalid controls page')
    openControls(input.page as Parameters<typeof openControls>[0])
    return
  }
  if (type === 'close-controls') {
    shellWindow?.close()
    return
  }
  if (type === 'quit') {
    app.quit()
    return
  }
  if (['check-updates', 'download-update', 'install-update'].includes(type)) {
    if (quitting || runtime.busy) return
    if (type === 'check-updates') {
      void updates
        .check()
        .then(async () => {
          if (source !== 'native' || quitting) return
          const snapshot = updates.snapshot()
          if (snapshot.phase === 'available' && snapshot.installable) {
            const choice = await dialog.showMessageBox({
              type: 'info',
              title: 'SuperDsh',
              message: updateLabel(snapshot, windowsLanguage),
              buttons: [t('下载更新', 'Download update'), t('稍后', 'Later')],
              defaultId: 0,
              cancelId: 1,
              detail: t(
                '下载完成后可一键安装并重启。',
                'When the download finishes, choose Install and restart.',
              ),
            })
            if (choice.response === 0 && !quitting) void updates.download()
          } else
            await dialog.showMessageBox({
              type: 'info',
              title: 'SuperDsh',
              message: updateLabel(snapshot, windowsLanguage),
            })
        })
        .catch((error) => runtime.diagnostics.append(String(error), 'warn'))
    } else if (type === 'download-update') void updates.download()
    else {
      if (updates.snapshot().phase !== 'ready') return
      void updates.install()
    }
    return
  }
  if (runtime.busy || quitting)
    throw new Error(
      t('另一项操作正在进行，请稍候。', 'Another operation is in progress.'),
    )
  runtime.busy = true
  native.refresh()
  try {
    if (type === 'onboarding-complete' || type === 'onboarding-skip') {
      if (
        !onboarding ||
        runtime.safeMode ||
        runtime.recoveryMode ||
        input.profile !== runtime.selected
      )
        throw new Error('Onboarding is unavailable for this Profile')
      // The Host has not loaded this Profile yet. Commit choices before starting it.
      runtime.profiles.finishOnboarding(
        runtime.selected,
        type === 'onboarding-complete'
          ? { features: input.features, computerUse: input.computerUse }
          : undefined,
      )
      onboarding = false
      shellWindow?.hide()
      void runtime.start().catch(() => {})
      openMain()
      shellWindow?.close()
      return
    }
    if (type === 'restart-onboarding') {
      if (runtime.safeMode || runtime.recoveryMode)
        throw new Error('Onboarding is unavailable in safe or recovery mode')
      if (onboarding) {
        openControls('onboarding')
        return
      }
      if (
        !(await confirmed(
          t('重新打开设置向导？', 'Reopen the setup wizard?'),
          t(
            '应用将重启，并带入当前 Profile 的设置。正在运行的任务会中断。',
            'The app will restart with your current Profile settings selected. Running tasks will be interrupted.',
          ),
        ))
      )
        return
      relaunch = relaunchArguments(process.argv.slice(1), false, false, true)
      app.quit()
      return
    }
    if (type === 'restart-app' || type === 'restart-recovery') {
      if (
        !(await confirmed(
          type === 'restart-recovery'
            ? t(
                '重启应用并进入恢复模式？',
                'Restart the application in recovery mode?',
              )
            : t('现在重启 SuperDsh？', 'Restart SuperDsh now?'),
          type === 'restart-recovery'
            ? t(
                '应用将先打开恢复助手，暂不加载当前 Profile 和插件。正在运行的任务会中断。',
                'The recovery assistant will open before loading the current Profile and plugins. Running tasks will be interrupted.',
              )
            : undefined,
        ))
      )
        return
      relaunch = relaunchArguments(
        process.argv.slice(1),
        type === 'restart-recovery',
        runtime.safeMode,
      )
      app.quit()
      return
    }
    if (type === 'create') {
      runtime.profiles.create(profileName(input.name))
      return
    }
    if (type === 'delete') {
      const name = profileName(input.name)
      if (name === runtime.selected || name === DEFAULT_PROFILE)
        throw new Error(
          t(
            '不能移除当前或默认 Profile。',
            'Cannot remove the active or default Profile.',
          ),
        )
      if (
        await confirmed(
          t(`移除 Profile「${name}」？`, `Remove Profile “${name}”?`),
          t(
            '其文件将移入恢复备份目录。共享的会话和设置会保留。',
            'Its files move to recovery backups. Shared sessions and settings are retained.',
          ),
        )
      )
        runtime.recovery.removeProfile(name, runtime.selected)
      return
    }
    if (type === 'reload') {
      if (runtime.recoveryMode || onboarding) {
        openMain()
        return
      }
      await reloadMain()
      return
    }
    if (type === 'devtools') {
      openMain()
      ;(runtime.recoveryMode || onboarding
        ? shellWindow
        : mainWindow)!.webContents.toggleDevTools()
      return
    }
    if (type === 'recovery-action') {
      await recoveryActions.execute(input)
      return
    }
    if (type === 'terminal') {
      const target = runtime.terminalTarget(source === 'shell')
      openDesktopTerminal({
        platform: process.platform,
        appExecutable: process.execPath,
        dshBootstrapPath: require.resolve('@superdsh/core/main/desktop-cli'),
        pnpmBinPath: bundledPnpmEntry(HARNESS_PACKAGE),
        electronVersion: process.versions.electron,
        ...target,
        productVersion: version,
        stateDir: desktopTerminalStateDirectory(
          join(target.homeDir, 'electron-user-data'),
          target.profileName,
        ),
        spawn,
        onLaunchError: (error) => runtime.report(error),
      })
      return
    }
    if (type === 'open-home') {
      await openPath(home)
      return
    }
    if (type === 'open-profile') {
      await openPath(runtime.profiles.directory(runtime.selected))
      return
    }
    if (type === 'open-logs') {
      runtime.diagnostics.flush()
      await openPath(dirname(runtime.diagnostics.file))
      return
    }
    if (type === 'open-backups') {
      privateDirectory(runtime.recovery.directory)
      await openPath(runtime.recovery.directory)
      return
    }
    if (type === 'open-browser' || type === 'open-lan') {
      await shell.openExternal(runtime.browserLink(type === 'open-lan'))
      return
    }
    if (type === 'copy-browser' || type === 'copy-lan') {
      clipboard.writeText(runtime.browserLink(type === 'copy-lan'))
      return
    }
    if (type === 'open-browser-url' || type === 'copy-browser-url') {
      const url = runtime.resolveBrowserLink(input.url)
      if (type === 'copy-browser-url') clipboard.writeText(url)
      else await shell.openExternal(url)
      return
    }
    if (type === 'export-ca' || type === 'diagnostics') {
      const certificate = runtime.lan?.caCertificate
      if (type === 'export-ca' && !certificate)
        throw new Error('LAN certificate is unavailable')
      const owner = raiseDialogOwner()
      const options = {
        title:
          type === 'export-ca'
            ? t('导出局域网 CA 证书', 'Export LAN CA certificate')
            : t(
                '导出诊断（分享前请检查内容）',
                'Export diagnostics (review before sharing)',
              ),
        defaultPath:
          type === 'export-ca'
            ? 'superdsh-ca.crt'
            : `superdsh-diagnostics-${Date.now()}.json`,
        filters: [
          {
            name: type === 'export-ca' ? 'CA certificate' : 'Diagnostics',
            extensions: [type === 'export-ca' ? 'crt' : 'json'],
          },
        ],
      }
      const result = await (owner === undefined
        ? dialog.showSaveDialog(options)
        : dialog.showSaveDialog(owner, options))
      if (!result.canceled && result.filePath && !quitting) {
        await writeFile(
          result.filePath,
          type === 'export-ca'
            ? certificate!
            : runtime.diagnostics.export(state()),
          { mode: 0o600 },
        )
        if (type === 'diagnostics') diagnosticsFile = result.filePath
      }
      return
    }
    if (type === 'preferences') {
      const preferences = parsePreferences(input.preferences)
      if (portsChanged(runtime.preferences, preferences)) {
        if (
          !(await confirmed(
            t(
              '应用访问设置并重启 Host？',
              'Apply access settings and restart the Host?',
            ),
            preferences.browserAccess && preferences.networkExposure === 'lan'
              ? t(
                  '开启后，同一网络中的设备可通过 HTTPS 访问。登录链接可授予访问权限，请仅与可信设备共享。正在运行的任务会被中断。',
                  'Devices on your network can connect over HTTPS. Login links grant access; share only with trusted devices. Running tasks will be interrupted.',
                )
              : undefined,
          ))
        )
          return
        await runtime.restart(() => runtime.writePreferences(preferences))
        if (mainWindow) await loadMainDocument(mainWindow)
      } else {
        if (
          preferences.browserAccess &&
          preferences.networkExposure === 'lan' &&
          (!runtime.preferences.browserAccess ||
            runtime.preferences.networkExposure !== 'lan') &&
          !(await confirmed(
            t('允许局域网 HTTPS 访问？', 'Allow LAN access over HTTPS?'),
            t(
              '同一网络中的设备可以连接。请仅向可信设备分享登录链接，并在设备上核对和信任 CA 证书。',
              'Devices on your local network can connect. Share login links only with trusted devices, and verify and trust the CA certificate on each device.',
            ),
          ))
        )
          return
        await runtime.applyPreferences(preferences)
      }
      if (mainWindow) applyWindowMaterial(mainWindow, preferences)
      return
    }
    if (
      ![
        'switch',
        'features',
        'restart',
        'recover',
        'safe-mode',
        'normal-mode',
        'rollback',
        'repair-global',
      ].includes(String(type))
    )
      throw new Error('Invalid Next command')
    const next = type === 'switch' ? profileName(input.name) : runtime.selected
    if (
      type === 'switch' &&
      next === runtime.selected &&
      !runtime.safeMode &&
      !runtime.recoveryMode &&
      runtime.backend.state.phase === 'ready'
    )
      return
    if (type === 'switch' && !runtime.profiles.selectable(next))
      throw new Error('Profile is unavailable for Desktop Next')
    const features =
      type === 'features' ? parseFeatures(input.features) : undefined
    if (type === 'rollback' && !runtime.recovery.latest(next))
      throw new Error(
        t(
          '尚无成功启动的配置备份。',
          'No successful-start configuration is available.',
        ),
      )
    const messages: Record<string, string> = {
      switch: t(
        `切换到 Profile「${next}」并重启应用？`,
        `Switch to Profile “${next}” and restart the application?`,
      ),
      recover: t(
        '备份并修复当前 Profile？将禁用第三方插件、远控和市场。',
        'Back up and repair this Profile? Third-party plugins, remote control and Market will be disabled.',
      ),
      'repair-global': t(
        '备份并停用全局补丁？这会影响所有 Next Profile。',
        'Back up and disable the global patch? This affects every Next Profile.',
      ),
      rollback: t(
        '恢复最近成功启动的 Profile 配置？当前配置会先备份。',
        'Restore the last successful-start Profile configuration? The current configuration will be backed up first.',
      ),
      'safe-mode': t(
        '在独立的临时环境中进入安全模式？原有数据和配置会保留。',
        'Enter safe mode in a separate temporary environment? Existing data and configuration are preserved.',
      ),
      'normal-mode': t(
        '退出安全模式并重启原 Profile？',
        'Exit Safe Mode and restart the original Profile?',
      ),
    }
    if (
      !(await confirmed(
        messages[String(type)] ??
          t(
            '重启工作环境以应用更改？',
            'Restart the environment to apply this change?',
          ),
      ))
    )
      return
    if (type === 'switch') {
      runtime.profiles.select(next)
      relaunch = relaunchArguments(process.argv.slice(1), false, false)
      app.quit()
      return
    }
    // Recovery actions can always bypass first-run setup to repair or inspect a Profile.
    onboarding = false
    await recoveryStopping
    await runtime.restart(async () => {
      if (type === 'recover') await runtime.profiles.recover(next)
      if (type === 'rollback') await recoveryActions.restoreCheckpoint()
      if (type === 'repair-global') runtime.recovery.repairGlobalPatch()
      if (features) runtime.profiles.setFeatures(next, features)
      if (type === 'safe-mode') runtime.safeMode = true
      else if (type !== 'restart') runtime.safeMode = false
    })
    await reloadMain()
    if (!runtime.safeMode && mainWindow) shellWindow?.close()
  } catch (error) {
    if (
      type === 'recovery-action' ||
      (onboarding &&
        (type === 'onboarding-complete' || type === 'onboarding-skip'))
    )
      runtime.diagnostics.append(String(error), 'error')
    else runtime.report(error)
    throw error
  } finally {
    runtime.busy = false
    native.refresh()
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  if (quitting) return
  try {
    managedAccount.initialize()
    await managedModels.start()
  } catch (error) {
    runtime.diagnostics.append(String(error), 'warn')
  }
  ipcMain.handle(
    IPC.platformAccount,
    async (event, action: unknown, value: unknown) => {
      assertSender(event, mainWindow, APP_URL)
      if (action === 'state') {
        const connector = managedConnector.state()
        const account = managedAccount.state()
        return {
          ...account,
          ...connector,
          error: account.error ?? connector.error,
          localImportAvailable: false,
        }
      }
      if (action === 'login' && typeof value === 'string')
        return managedAccount.login(value)
      if (action === 'login-with-password') {
        if (!value || typeof value !== 'object')
          throw new Error('Invalid platform login')
        const input = value as Record<string, unknown>
        if (
          typeof input.origin !== 'string' ||
          input.origin.length > 2048 ||
          typeof input.identifier !== 'string' ||
          !input.identifier.trim() ||
          input.identifier.length > 320 ||
          typeof input.password !== 'string' ||
          !input.password ||
          input.password.length > 1024
        )
          throw new Error('请输入有效的平台地址、用户名和密码。')
        return managedAccount.loginWithPassword({
          origin: input.origin,
          identifier: input.identifier,
          password: input.password,
        })
      }
      if (action === 'change-password') {
        if (!value || typeof value !== 'object')
          throw new Error('Invalid password change')
        const input = value as Record<string, unknown>
        if (
          typeof input.newPassword !== 'string' ||
          input.newPassword.length < 8 ||
          input.newPassword.length > 1024
        )
          throw new Error('新密码长度必须为 8 至 1024 个字符。')
        return managedAccount.changePassword({ newPassword: input.newPassword })
      }
      if (action === 'cancel') return managedAccount.cancelLogin()
      if (action === 'logout' || action === 'local')
        return managedAccount.logout()
      if (action === 'connect') {
        if (runtime.safeMode) throw new Error('安全模式不启用远程连接')
        await runtime.startup
        return managedConnector.connect()
      }
      if (action === 'disconnect') return managedConnector.stop()
      if (action === 'import')
        throw new Error(
          '当前直接使用本地历史。旧数据可在设置中的数据导入入口导入空目标目录。',
        )
      throw new Error('Unknown platform account action')
    },
  )
  ipcMain.handle(IPC.platformRemote, (event, request: PlatformRequest) => {
    assertSender(event, mainWindow, APP_URL)
    return managedRemote.request(request)
  })
  ipcMain.handle(IPC.platformWatch, (event, value: unknown) => {
    assertSender(event, mainWindow, APP_URL)
    if (typeof value === 'string' || value === null)
      return managedRemote.watch(value)
    if (!value || typeof value !== 'object')
      throw new Error('Invalid platform subscription')
    const request = value as Record<string, unknown>
    if (
      typeof request.ownerId !== 'string' ||
      !request.ownerId ||
      request.ownerId.length > 128
    )
      throw new Error('Invalid platform subscription owner')
    if (request.action === 'stop')
      return managedRemote.stopWatch(request.ownerId)
    if (
      request.action === 'watch' &&
      (typeof request.sessionId === 'string' || request.sessionId === null)
    )
      return managedRemote.watch(
        request.sessionId,
        request.ownerId,
        request.identity as PlatformIdentitySnapshot | undefined,
      )
    throw new Error('Invalid platform subscription')
  })
  ipcMain.handle(
    IPC.platformUpload,
    (
      event,
      sessionId: string,
      files: { name: string; type: string; data: Uint8Array }[],
      identity?: PlatformIdentitySnapshot,
    ) => {
      assertSender(event, mainWindow, APP_URL)
      return managedRemote.upload(sessionId, files, identity)
    },
  )
  if (process.platform === 'darwin' && !app.isPackaged)
    app.dock?.setIcon(join(root, 'build', 'app-icon-mac.png'))
  // Recovery can open without a Host; Chromium's app locale may differ from the OS language.
  windowsLanguage = preferredDesktopLocale([
    ...app.getPreferredSystemLanguages(),
    app.getLocale(),
  ])
  // Read once, before anything can start a Host: a proxy client's "system proxy" switch sets no
  // environment variable, and only Chromium can evaluate it (PAC/WPAD included). Changing the
  // proxy takes effect on the next application start.
  systemProxy = await probeSystemProxy(session.defaultSession)
  protocol.handle('dsh-app', async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') {
      const response = await serveWebDocument(
        request,
        dirname(runtimeAssets.nativeIndex),
        false,
      )
      response.headers.set(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'",
      )
      return response
    }
    if (url.hostname !== 'app' && url.hostname !== 'compat')
      return new Response(null, { status: 404 })
    if (
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/compatibility.html' ||
      url.pathname.startsWith('/assets/') ||
      ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)
    )
      return serveWebDocument(request, webRoot)
    const auth = runtime.auth
    if (!runtime.backend.host || !auth)
      return new Response(null, { status: 503 })
    return forwardWebRequest(
      request,
      auth.url,
      auth.cookie,
      auth.token,
      url.hostname === 'compat' ? EXTENSION_ORIGIN : 'dsh-app://app',
    )
  })
  ipcMain.handle(IPC.boot, async (event) => {
    assertApplicationSender(event)
    await runtime.startup
    if (!runtime.backend.host || !runtime.auth)
      throw new Error('Next Host is unavailable')
    return {
      injections: await runtime.injections(),
      streamBaseUrl: new URL(runtime.auth.url).origin,
    }
  })
  ipcMain.handle(IPC.failed, (event, message: unknown) => {
    assertApplicationSender(event)
    if (typeof message !== 'string') throw new Error('Invalid boot error')
    if (extensions.owns(event.sender)) {
      extensions.fail(new Error(message.slice(0, 4096)))
      return
    }
    runtime.report(new Error(message.slice(0, 4096)))
  })
  ipcMain.handle(IPC.extensionOpen, (event) => {
    assertSender(event, mainWindow, APP_URL)
    return extensions.open()
  })
  ipcMain.handle(IPC.extensionClose, (event) => {
    assertSender(event, mainWindow, APP_URL)
    extensions.close()
  })
  ipcMain.handle(IPC.extensionState, (event) => {
    assertSender(event, mainWindow, APP_URL)
    return extensions.state()
  })
  ipcMain.handle(IPC.state, (event) => {
    assertDesktopSender(event)
    return state()
  })
  ipcMain.handle(IPC.dataImport, (event, action: unknown, value: unknown) => {
    assertSender(event, shellWindow, SHELL_URL)
    if (quitting) throw new Error('SuperDsh is shutting down')
    if (
      runtime.busy &&
      !dataImport.busy &&
      ['inspect', 'execute', 'use', 'rollback'].includes(String(action))
    ) {
      throw new Error(
        t('另一项操作正在进行，请稍候。', 'Another operation is in progress.'),
      )
    }
    return dataImport.dispatch(action, value)
  })
  ipcMain.handle(IPC.settingsTake, (event) => {
    assertApplicationSender(event)
    if (extensions.owns(event.sender)) return undefined
    const page = pendingSettings
    pendingSettings = undefined
    return page
  })
  ipcMain.handle(IPC.browserLinks, (event) => {
    assertDesktopSender(event)
    return runtime.browserLinks()
  })
  ipcMain.handle(IPC.browserAcquire, (event, workspace: unknown) => {
    assertApplicationSender(event)
    if (quitting) throw new Error('Desktop browser is unavailable')
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease: unknown) => {
    assertApplicationSender(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.permissionQuery, (event, permission: unknown) => {
    assertDesktopSender(event)
    return permissions.query(permission)
  })
  const permissionGesture = async (
    event: IpcMainInvokeEvent,
  ): Promise<void> => {
    assertDesktopSender(event)
    if (
      !event.sender.isFocused() ||
      !(await event.sender.executeJavaScript(
        'navigator.userActivation.isActive',
      ))
    ) {
      throw new Error(
        'Desktop permission requests require a focused window and user gesture',
      )
    }
    assertDesktopSender(event)
  }
  ipcMain.handle(IPC.permissionRequest, async (event, permission: unknown) => {
    await permissionGesture(event)
    return permissions.request(permission)
  })
  ipcMain.handle(IPC.permissionSettings, async (event, permission: unknown) => {
    await permissionGesture(event)
    await permissions.openSettings(permission)
  })
  installMediaPermissions(session.defaultSession, permissions, {
    window: () => mainWindow,
    extension: () => extensions.contents,
    language: () => windowsLanguage,
    warn: (error) => runtime.diagnostics.append(String(error), 'warn'),
  })
  ipcMain.handle(IPC.material, (event) => {
    assertApplicationSender(event)
    return windowMaterial(runtime.preferences)
  })
  ipcMain.handle(IPC.command, (event, value: unknown) => {
    assertDesktopSender(event)
    return command(
      value,
      event.sender === shellWindow?.webContents ? 'shell' : 'app',
    )
  })
  let picking: Promise<string | null> | undefined
  ipcMain.handle(IPC.directory, (event) => {
    assertApplicationSender(event)
    const window = mainWindow!
    show(window)
    picking ??= dialog
      .showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
      })
      .then((result) =>
        result.canceled ? null : (result.filePaths[0] ?? null),
      )
      .finally(() => {
        picking = undefined
      })
    return picking
  })
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const auth = runtime.auth
      const compatibility = details.webContentsId === extensions.contents?.id
      const owner = compatibility
        ? extensions.contents
        : mainWindow && !mainWindow.isDestroyed()
          ? mainWindow.webContents
          : undefined
      const origin = compatibility ? EXTENSION_ORIGIN : 'dsh-app://app'
      const requestHeaders = appRequestHeaders(
        details,
        owner,
        auth?.token,
        origin,
      )
      const target = new URL(details.url)
      if (
        target.protocol !== 'ws:' ||
        target.hostname !== '127.0.0.1' ||
        !auth ||
        details.webContentsId !== owner?.id
      )
        return callback({ requestHeaders })
      const host = new URL(auth.url)
      if (target.host !== host.host) return callback({ requestHeaders })
      const headers = Object.fromEntries(
        Object.entries(requestHeaders).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      )
      if (headers.origin !== origin) return callback({ cancel: true })
      callback({
        requestHeaders: {
          ...headers,
          origin: host.origin,
          cookie: auth.cookie,
          [NATIVE_ACCESS_HEADER]: auth.token,
          'sec-fetch-site': 'same-origin',
        },
      })
    },
  )
  ipcMain.on(IPC.nativeThemeSet, (event, source: unknown) => {
    try {
      assertSender(event, mainWindow, APP_URL)
    } catch {
      return
    }
    if (source === 'light' || source === 'dark' || source === 'system')
      nativeTheme.themeSource = source
  })
  ipcMain.on(IPC.locale, (event, language: unknown) => {
    try {
      assertSender(event, mainWindow, APP_URL)
    } catch {
      return
    }
    if (
      typeof language !== 'string' ||
      !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)
    )
      return
    if (!runtime.safeMode) {
      try {
        nativeLocale.remember(runtime.selected, language)
      } catch (error) {
        runtime.diagnostics.append(String(error), 'warn')
      }
    }
    if (language === windowsLanguage) return
    windowsLanguage = language
    native.refresh()
  })
  ipcMain.handle(IPC.localeRead, (event) => {
    assertApplicationSender(event)
    return {
      languages: [...app.getPreferredSystemLanguages(), app.getLocale()],
      preference: null,
    }
  })
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed())
      applyWindowMaterial(mainWindow, runtime.preferences)
  })
  runtime.safeMode = process.argv.includes(SAFE_ARGUMENT)
  runtime.recoveryMode = process.argv.includes(RECOVERY_ARGUMENT)
  runtime.initialize()
  if (dataLocation.error) {
    runtime.recoveryMode = true
    runtime.report(dataLocation.error)
  }
  if (!runtime.safeMode && !runtime.recoveryMode) {
    try {
      runtime.profiles.ensure(runtime.selected)
      onboarding =
        process.argv.includes(ONBOARDING_ARGUMENT) ||
        runtime.profiles.onboardingRequired(runtime.selected)
      if (onboarding)
        onboardingComputerUse = runtime.profiles.computerUseEnabled(
          runtime.selected,
        )
    } catch (error) {
      onboarding = false
      runtime.recoveryMode = true
      runtime.report(error)
    }
  }
  native.createTray()
  updates.start()
  Menu.setApplicationMenu(
    process.platform === 'win32'
      ? null
      : Menu.buildFromTemplate([
          { label: 'SuperDsh', submenu: native.items() },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
  )
  if (process.platform === 'win32') {
    ipcMain.handle(
      IPC.windowsMenu,
      (event, name: unknown, x: unknown, y: unknown) => {
        assertSender(event, mainWindow, APP_URL)
        if (
          (name !== 'application' && name !== 'edit') ||
          typeof x !== 'number' ||
          typeof y !== 'number' ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          y < 0 ||
          x > 100_000 ||
          y > 100_000
        )
          throw new Error('Invalid native menu request')
        const window = mainWindow!
        const messages = resolveDesktopLocale(windowsLanguage).messages
        const editItem = (
          label: string,
          keyCode: string,
          modifiers: Array<'control'>,
          accelerator?: string,
        ): MenuItemConstructorOptions => ({
          label,
          accelerator,
          click: () => {
            window.webContents.focus()
            window.webContents.sendInputEvent({
              type: 'keyDown',
              keyCode,
              modifiers,
            })
            window.webContents.sendInputEvent({
              type: 'keyUp',
              keyCode,
              modifiers,
            })
          },
        })
        const items: MenuItemConstructorOptions[] =
          name === 'application'
            ? native.items()
            : [
                editItem(messages.undo, 'Z', ['control'], 'Ctrl+Z'),
                editItem(messages.redo, 'Y', ['control'], 'Ctrl+Y'),
                { type: 'separator' },
                editItem(messages.cut, 'X', ['control'], 'Ctrl+X'),
                editItem(messages.copy, 'C', ['control'], 'Ctrl+C'),
                editItem(messages.paste, 'V', ['control'], 'Ctrl+V'),
                editItem(messages.delete, 'Delete', []),
                { type: 'separator' },
                editItem(messages.selectAll, 'A', ['control'], 'Ctrl+A'),
              ]
        const zoom = window.webContents.getZoomFactor()
        return new Promise<void>((resolvePopup) => {
          Menu.buildFromTemplate(items).popup({
            window,
            x: Math.round(x * zoom),
            y: Math.round(y * zoom),
            callback: resolvePopup,
          })
        })
      },
    )
    ipcMain.on(
      IPC.windowsAppearance,
      (event, language: unknown, color: unknown, symbolColor: unknown) => {
        try {
          assertSender(event, mainWindow, APP_URL)
        } catch {
          return
        }
        // Caption paint can run before the official locale service initializes;
        // IPC.locale is the only renderer authority for the application language.
        const validColor = (value: unknown): value is string =>
          typeof value === 'string' &&
          /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
        if (validColor(color) && validColor(symbolColor))
          mainWindow!.setTitleBarOverlay({ color, symbolColor })
      },
    )
  }
  if (runtime.recoveryMode) openControls('recovery')
  else if (onboarding) openControls('onboarding')
  else {
    void runtime
      .start()
      .then(refreshPlatformConnection)
      .catch(() => {})
    openMain()
  }
  app.on('activate', openMain)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !native.available && !replacingWindow)
      app.quit()
  })
}

app.on(
  'before-quit',
  createShutdownCoordinator({
    ownsInstance: () => ownsInstance,
    begin: () => {
      quitting = true
      // Keep reconnection UI out of the quit transition before draining every resource.
      for (const window of [mainWindow, shellWindow]) {
        if (window && !window.isDestroyed()) window.hide()
      }
      native.close()
      extensions.close()
      platformLogin.close()
    },
    parallelCleanup: () => updates.dispose(installingUpdate),
    cleanup: [
      () => managedRemote.close(),
      () => managedModels.close(),
      () => managedConnector.stop(),
      () => managedAccount.close(),
      () => frontendDevelopment.dispose(),
      () => dataImport.close(),
      () => recoveryActions.dispose(),
      () => runtime.close(),
    ],
    complete: async () => {
      if (installingUpdate) {
        try {
          await updateInstaller.launch()
        } catch (error) {
          runtime.diagnostics.append(String(error), 'error')
          dialog.showErrorBox(
            t('更新未能安装', 'Update could not be installed'),
            t(
              '应用将重新打开，请在设置中重试更新。',
              'The application will reopen. Retry the update in Settings.',
            ),
          )
          app.relaunch({
            args: relaunchArguments(process.argv.slice(1), false, false),
          })
          app.quit()
        }
        if (process.platform === 'darwin') return
      }
      if (relaunch) app.relaunch({ args: relaunch })
      app.quit()
    },
    failed: (error) => {
      console.error(error)
      app.exit(1)
    },
  }),
)

ownsInstance = claimDesktopSingleInstance(app, openMain)
if (process.env.SUPERDSH_WATCH === '1' && process.send) {
  process.on('message', (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'superdsh:dev-stop'
    )
      app.quit()
  })
}
if (ownsInstance) void main().catch((error) => runtime.report(error))
