/** Browser-safe DTOs retained by the product's shared settings and recovery views. */
export type DesktopLocale = 'zh' | 'en'
export type DesktopShellMode = 'compatibility' | 'extended' | 'advanced'
export type DesktopNetworkExposure = 'loopback' | 'lan'
export type DesktopStartupRecoveryOperationStage =
  | 'bundle-selection'
  | 'checkpoint-restore'
  | 'dependency-materialization'
  | 'plugin-change'

export const DESKTOP_RENDERER_ACTIONS_BRIDGE = 'dshDesktopActions'
export const DESKTOP_RENDERER_ACTION_CHANNEL = 'dsh-desktop:renderer-action'
export type DesktopRendererAction =
  | 'terminal'
  | 'restart'
  | 'restart-recovery'
  | 'reload'
  | 'developer'
  | 'diagnostics'
  | 'check-for-updates'
export interface DesktopRendererActionsBridge {
  invoke(action: DesktopRendererAction): Promise<void>
}
export function desktopBrowserAccessAvailable(mode: DesktopShellMode): boolean {
  return mode === 'compatibility'
}
export function desktopBrowserAccessEnabled(
  mode: DesktopShellMode,
  storedOpenBrowser: boolean,
  exposure: DesktopNetworkExposure,
): boolean {
  return (
    desktopBrowserAccessAvailable(mode) &&
    (storedOpenBrowser || exposure === 'lan')
  )
}
