import type { ReactNode } from 'react'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopMarketProvider,
  DesktopSettingsApi,
} from '@superdsh/core/client/desktop-settings-api'
import type {
  DesktopShellSettings,
  DesktopNotificationSettings,
} from '@superdsh/core/contracts/desktop-settings'
import type { DesktopSettingsForm } from './settings-bridge.ts'
import type { DesktopClientPlatform } from './environment.ts'

/** Registration-side business face for the Desktop settings section. */
export interface DesktopSettingsSectionInjected {
  readonly api: DesktopSettingsApi
  readonly platform: DesktopClientPlatform
  /** Installed Desktop product version rendered by the update section. */
  readonly version: string
  readonly initialMode: DesktopShellSettings['mode']
  readonly micaSupported: boolean
  readonly setMode: (mode: DesktopShellSettings['mode']) => Promise<void>
  readonly desktopSettings: Pick<
    DesktopSettingsForm<DesktopShellSettings>,
    'getSnapshot' | 'subscribe' | 'set'
  >
  readonly notificationSettings: Pick<
    DesktopSettingsForm<DesktopNotificationSettings>,
    'getSnapshot' | 'subscribe' | 'set'
  >
  /** Hosts can omit unsupported features while sharing the existing page. */
  readonly capabilities?: {
    readonly pluginSelectors?: boolean
    readonly windowModes?: boolean
    readonly featuresReadOnly?: boolean
    readonly markets?: readonly DesktopMarketProvider[]
    readonly materialRequiresRestart?: boolean
    readonly nativeLanConfirmation?: boolean
    readonly jobNotifications?: boolean
    readonly updates?: boolean
  }
  readonly introNotice?: ReactNode
  readonly browserActions?: ReactNode
  readonly extraSections?: ReactNode
}

/** Renderer-composed props for the official settings section entry. */
export type DesktopSettingsSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<'desktop.settings'> &
  InjectFace<DesktopSettingsSectionInjected>

export type Translate = DesktopSettingsSectionProps['t']
export type BusyOperation =
  | 'load'
  | 'create-profile'
  | 'select-profile'
  | 'delete-profile'
  | 'select-aa'
  | 'select-market'
  | 'mode'
  | 'material'
  | 'web'
  | 'notification'
export type RestartState = 'none' | 'restarting' | 'required'
