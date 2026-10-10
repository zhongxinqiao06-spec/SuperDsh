/** Resolve the enclosing product manifest without a reverse workspace dependency. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function desktopInstallationPackage(from = import.meta.url): string {
  let directory = dirname(fileURLToPath(from))
  for (;;) {
    const manifest = join(directory, 'package.json')
    try {
      if (
        (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string })
          .name === '@superdsh/desktop'
      )
        return manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error('SuperDsh product installation could not be located')
    directory = parent
  }
}

export interface DesktopRuntimeAssets {
  frontendIndex: string
  frontendManifest: string
  nativeIndex: string
}

/** Product assembly chooses the UI artifacts; Core only consumes resolved files. */
export function desktopRuntimeAssets(
  manifest = desktopInstallationPackage(),
): DesktopRuntimeAssets {
  const product = JSON.parse(readFileSync(manifest, 'utf8')) as {
    superdsh?: { runtimeAssets?: Partial<DesktopRuntimeAssets> }
  }
  const configured = product.superdsh?.runtimeAssets
  const require = createRequire(manifest)
  const asset = (name: keyof DesktopRuntimeAssets): string => {
    const value = configured?.[name]
    if (typeof value !== 'string' || !value)
      throw new Error(
        `SuperDsh product runtime asset is not configured: ${name}`,
      )
    return require.resolve(value)
  }
  return {
    frontendIndex: asset('frontendIndex'),
    frontendManifest: asset('frontendManifest'),
    nativeIndex: asset('nativeIndex'),
  }
}
