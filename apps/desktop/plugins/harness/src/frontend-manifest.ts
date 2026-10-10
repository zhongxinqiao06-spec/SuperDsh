import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Both product and compatibility documents belong to the validated installed frontend. */
export function frontendDocumentPaths(manifestPath: string | undefined) {
  if (!manifestPath || !isAbsolute(manifestPath))
    throw new Error(
      'SuperDsh Host requires an absolute frontend artifact manifest',
    )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion?: unknown
    harnessVersion?: unknown
    modules?: unknown
    staticRoot?: unknown
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.harnessVersion !== '0.1.7-alpha.2' ||
    !manifest.modules ||
    typeof manifest.modules !== 'object' ||
    Array.isArray(manifest.modules)
  ) {
    throw new Error('Unsupported SuperDsh frontend artifact manifest')
  }
  const root = dirname(manifestPath)
  if (
    typeof manifest.staticRoot !== 'string' ||
    !manifest.staticRoot ||
    isAbsolute(manifest.staticRoot)
  ) {
    throw new Error('SuperDsh frontend manifest requires a relative staticRoot')
  }
  const index = resolve(root, manifest.staticRoot, 'index.html')
  const indexRelative = relative(realpathSync(root), realpathSync(index))
  if (
    indexRelative === '..' ||
    indexRelative.startsWith('..\\') ||
    indexRelative.startsWith('../') ||
    isAbsolute(indexRelative) ||
    !statSync(index).isFile()
  )
    throw new Error('Frontend index is outside its manifest or unavailable')
  const compatibilityIndex = resolve(
    root,
    manifest.staticRoot,
    'compatibility.html',
  )
  const compatibilityRelative = relative(
    realpathSync(root),
    realpathSync(compatibilityIndex),
  )
  if (
    compatibilityRelative === '..' ||
    compatibilityRelative.startsWith('..\\') ||
    compatibilityRelative.startsWith('../') ||
    isAbsolute(compatibilityRelative) ||
    !statSync(compatibilityIndex).isFile()
  )
    throw new Error(
      'Frontend compatibility index is outside its manifest or unavailable',
    )
  return {
    manifest: {
      ...manifest,
      modules: manifest.modules as Record<string, unknown>,
    },
    manifestPath,
    root,
    index,
    compatibilityIndex,
  }
}

/** Published frontend artifacts are required at the desktop boundary, never source fallbacks. */
export function frontendRuntimePatch(
  manifestPath: string | undefined,
  trustedHosts: readonly string[] = [],
): {
  id: string
  config: Record<string, string | boolean | readonly string[]>
}[] {
  const {
    manifest,
    root,
    index,
    manifestPath: validatedManifestPath,
  } = frontendDocumentPaths(manifestPath)
  const modules = Object.entries(manifest.modules)
  if (modules.length === 0)
    throw new Error('SuperDsh frontend artifact manifest is empty')
  for (const [id, raw] of modules) {
    const entry = raw as { path?: unknown }
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      isAbsolute(entry.path)
    ) {
      throw new Error(`Invalid frontend artifact path for ${id}`)
    }
    const file = resolve(root, entry.path)
    const local = relative(root, file)
    if (
      local === '..' ||
      local.startsWith('..\\') ||
      local.startsWith('../') ||
      isAbsolute(local) ||
      !statSync(file).isFile()
    )
      throw new Error(
        `Frontend artifact is outside its manifest or unavailable: ${id}`,
      )
  }
  return [
    {
      id: 'modules',
      config: { clientArtifactManifest: validatedManifestPath },
    },
    // Cordis replaces the row's complete config. Keep the desktop's noninteractive
    // startup and trust configuration explicitly when changing its static entry.
    {
      id: 'web-runtime',
      config: {
        frontendIndex: index,
        openBrowser: false,
        printUrl: true,
        surfaceContext: true,
        trustedHosts,
      },
    },
  ]
}
