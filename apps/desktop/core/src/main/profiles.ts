/** Platform-local installation identity, with the implementation owned by the Harness adapter. */
import { desktopInstallationPackage } from './installation.ts'
export * from '@superdsh/harness/profiles'
export const NEXT_PACKAGE = desktopInstallationPackage()
