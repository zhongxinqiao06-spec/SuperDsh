import { stripClientSuffix, type BootManifest } from './manifest.ts'

/** Filter both initial and live graphs; never silently admit an unknown dependency. */
export function admitManifest(
  manifest: BootManifest,
  allow: ((id: string) => boolean) | undefined,
  seeds: ReadonlySet<string>,
): BootManifest {
  if (allow === undefined) return manifest
  const modules = manifest.modules.filter((row) => allow(row.id))
  const ids = new Set(modules.map((row) => row.id))
  for (const row of modules) {
    for (const dependency of [...row.inject, ...row.external]) {
      const id = stripClientSuffix(dependency)
      if (seeds.has(dependency) || ids.has(id)) continue
      throw new Error(
        `Product UI module ${row.id} depends on unavailable or compatibility-only module ${dependency}`,
      )
    }
  }
  return {
    ...manifest,
    modules,
    plugins: manifest.plugins.filter((row) => ids.has(row.id)),
  }
}
