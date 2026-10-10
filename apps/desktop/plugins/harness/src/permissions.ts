import type {} from '@deepseek-ai/cordis'
import type { DesktopPermissions } from '@superdsh/core/contracts/permissions'
export * from '@superdsh/core/contracts/permissions'
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopPermissions: DesktopPermissions
  }
}
