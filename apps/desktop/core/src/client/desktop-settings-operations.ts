import type {
  DesktopSettingsApi,
  DesktopSettingsView,
} from './desktop-settings-api.ts'
import type {
  SettingsForm,
  DesktopShellSettings,
} from '../contracts/desktop-settings.ts'

type LanPollWait = (signal: AbortSignal) => Promise<void>

const LAN_POLL_INTERVAL_MS = 250
const LAN_POLL_MAX_READS = 21

function waitForLanPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, LAN_POLL_INTERVAL_MS)
    const cancel = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

/** Refresh Host state, briefly following an in-flight hot LAN transition. */
export async function readDesktopSettingsUntilLanSettled(
  api: Pick<DesktopSettingsApi, 'read'>,
  publish: (view: DesktopSettingsView) => void,
  signal: AbortSignal,
  wait: LanPollWait = waitForLanPoll,
): Promise<DesktopSettingsView> {
  let latest: DesktopSettingsView | undefined
  for (let read = 0; read < LAN_POLL_MAX_READS; read += 1) {
    signal.throwIfAborted()
    latest = await api.read()
    signal.throwIfAborted()
    publish(latest)
    if (latest.web.lanState !== 'starting' || read === LAN_POLL_MAX_READS - 1)
      return latest
    await wait(signal)
  }
  throw new Error('SuperDsh: unreachable LAN settings polling state')
}

/** Persist ordinary-browser permission and refresh the already-running edge. */
export async function persistDesktopBrowserAccessHot(
  settings: Pick<SettingsForm<DesktopShellSettings>, 'set'>,
  checked: boolean,
  currentExposure: DesktopShellSettings['networkExposure'],
  refresh: () => Promise<DesktopSettingsView>,
): Promise<DesktopSettingsView> {
  if (!checked && currentExposure === 'lan') {
    await settings.set('networkExposure', 'loopback')
  }
  await settings.set('openBrowser', checked)
  return refresh()
}

/** Persist LAN intent and refresh its hot HTTPS ingress state. */
export async function persistDesktopNetworkExposureHot(
  settings: Pick<SettingsForm<DesktopShellSettings>, 'set'>,
  exposure: DesktopShellSettings['networkExposure'],
  refresh: () => Promise<DesktopSettingsView>,
): Promise<DesktopSettingsView> {
  await settings.set('networkExposure', exposure)
  return refresh()
}

export type DesktopProfileChange = {
  kind: 'create' | 'select' | 'delete'
  name: string
}
export type DesktopProfileChangeResult =
  | { status: 'unchanged' }
  | { status: 'updated'; view: DesktopSettingsView }
  | { status: 'restart-required' }

/** Profile normalization, persistence and restart decisions belong to Core. */
export async function changeDesktopProfile(
  api: Pick<
    DesktopSettingsApi,
    'read' | 'createProfile' | 'selectProfile' | 'deleteProfile'
  >,
  change: DesktopProfileChange,
  refresh: () => Promise<DesktopSettingsView> = () => api.read(),
): Promise<DesktopProfileChangeResult> {
  if (change.kind === 'create') {
    const name = change.name.trim()
    if (!name) return { status: 'unchanged' }
    return { status: 'updated', view: await api.createProfile(name) }
  }
  if (change.kind === 'delete')
    return { status: 'updated', view: await api.deleteProfile(change.name) }
  const result = await api.selectProfile(change.name)
  return result.restartRequired
    ? { status: 'restart-required' }
    : { status: 'updated', view: await refresh() }
}
