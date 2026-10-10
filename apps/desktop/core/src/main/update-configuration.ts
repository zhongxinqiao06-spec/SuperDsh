/** Only public release URLs are accepted; no updater credentials enter product configuration. */
import { lstatSync, readFileSync } from 'node:fs'
import { desktopInstallationPackage } from './installation.ts'
import { dirname, join } from 'node:path'
import { validatedUpdateUrl } from '../platform/shared/update-checker.ts'

export interface SuperdshUpdateConfiguration {
  versionUrl: string
  downloadUrls: Partial<Record<'win32' | 'darwin', string>>
  allowedDownloadPrefixes: readonly string[]
}
export function validateUpdateConfiguration(
  value: unknown,
): SuperdshUpdateConfiguration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid SuperDsh update configuration')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    throw new Error('Unsupported SuperDsh update configuration version')
  const downloads = input.downloadUrls ?? {}
  if (!downloads || typeof downloads !== 'object' || Array.isArray(downloads))
    throw new Error('Invalid SuperDsh download URLs')
  const downloadUrls: SuperdshUpdateConfiguration['downloadUrls'] = {}
  for (const platform of ['win32', 'darwin'] as const) {
    const url = (downloads as Record<string, unknown>)[platform]
    if (url === undefined || url === '') continue
    if (typeof url !== 'string')
      throw new Error('Invalid SuperDsh download URL')
    downloadUrls[platform] = validatedUpdateUrl(url)
  }
  const prefixes = input.allowedDownloadPrefixes ?? []
  if (
    !Array.isArray(prefixes) ||
    prefixes.some((prefix) => typeof prefix !== 'string')
  )
    throw new Error('Invalid SuperDsh download mirrors')
  const allowedDownloadPrefixes = prefixes.map((prefix) => {
    const url = new URL(validatedUpdateUrl(prefix))
    if (
      !url.pathname.endsWith('/') ||
      url.pathname === '/' ||
      url.search ||
      /%2e|%2f|%5c/iu.test(url.pathname)
    )
      throw new Error(
        'Update mirrors must identify an HTTPS repository directory ending in /',
      )
    return url.href
  })
  if (input.versionUrl === undefined || input.versionUrl === '') {
    if (Object.keys(downloadUrls).length || prefixes.length)
      throw new Error('SuperDsh version URL is required')
    return undefined
  }
  if (typeof input.versionUrl !== 'string')
    throw new Error('Invalid SuperDsh version URL')
  return {
    versionUrl: validatedUpdateUrl(input.versionUrl),
    downloadUrls,
    allowedDownloadPrefixes,
  }
}

/** Product file is installed beside package.json. Environment values override public URL fields only. */
export function readUpdateConfiguration(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): SuperdshUpdateConfiguration | undefined {
  const path =
    options.path ??
    join(dirname(desktopInstallationPackage()), 'product-update.json')
  let product: Record<string, unknown> = {}
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
      throw new Error('Invalid SuperDsh product update file')
    product = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!product || typeof product !== 'object' || Array.isArray(product))
      throw new Error('Invalid SuperDsh product update file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const env = options.env ?? process.env
  const downloads =
    product.downloadUrls && typeof product.downloadUrls === 'object'
      ? product.downloadUrls
      : {}
  return validateUpdateConfiguration({
    ...product,
    versionUrl: env.SUPERDSH_UPDATE_VERSION_URL ?? product.versionUrl,
    downloadUrls: {
      ...downloads,
      ...(env.SUPERDSH_UPDATE_WINDOWS_URL === undefined
        ? {}
        : { win32: env.SUPERDSH_UPDATE_WINDOWS_URL }),
      ...(env.SUPERDSH_UPDATE_MAC_URL === undefined
        ? {}
        : { darwin: env.SUPERDSH_UPDATE_MAC_URL }),
    },
    allowedDownloadPrefixes:
      env.SUPERDSH_UPDATE_ALLOWED_PREFIXES === undefined
        ? product.allowedDownloadPrefixes
        : JSON.parse(env.SUPERDSH_UPDATE_ALLOWED_PREFIXES),
  })
}
