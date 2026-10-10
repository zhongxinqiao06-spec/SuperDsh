import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export function assertBrowserInput(id, _root) {
  const normalized = id.replaceAll('\\', '/')
  if (
    normalized.includes('/deepseek-harness/') ||
    /\/node_modules\/@deepseek-ai\/dsh-[^/]+\//.test(normalized)
  ) {
    throw new Error(
      `Frontend input must use owned source, not an upstream runtime artifact: ${id}`,
    )
  }
  return normalized
}

export function readSourceManifest(root) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'source-manifest.json'), 'utf8'),
  )
  if (
    manifest.schemaVersion !== 1 ||
    manifest.harnessVersion !== '0.1.7-alpha.2'
  )
    throw new Error('Unsupported frontend source manifest')
  for (const [id, file] of Object.entries(manifest.exports)) {
    const target = realpathSync(resolve(root, file))
    const local = relative(resolve(root, 'src'), target)
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('../') ||
      local.startsWith('..\\')
    )
      throw new Error(`Source export escapes frontend: ${id}`)
  }
  return manifest
}

export function ownedSourcePlugin(root, manifest, record) {
  return {
    name: 'superdsh-owned-browser-source',
    enforce: 'pre',
    resolveId(id) {
      if (Object.hasOwn(manifest.exports, id))
        return resolve(root, manifest.exports[id])
      if (id.startsWith('@deepseek-ai/dsh-'))
        throw new Error(
          `Browser value import has no owned source mapping: ${id}`,
        )
      return null
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules)) {
          try {
            assertBrowserInput(id, root)
          } catch (error) {
            throw new Error(
              `${error.message}\nImported by: ${(this.getModuleInfo(id)?.importers ?? []).join(', ')}`,
              { cause: error },
            )
          }
          const clean = id
            .replace(/^\0dsh-(?:inline-|global-)?css:/, '')
            .replace(/\.css\.mjs$/, '.css')
          if (isAbsolute(clean))
            record.add(relative(root, clean).replaceAll('\\', '/'))
        }
      }
    },
  }
}
