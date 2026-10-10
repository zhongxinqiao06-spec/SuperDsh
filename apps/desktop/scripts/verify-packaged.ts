/** Check the actual unpacked payload, including runtime-only dependencies, without a GUI. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

interface PackContext {
  appOutDir: string
  electronPlatformName: string
}
export function verifyNextPayload(root: string): void {
  // The shell, fixed backend plugin and independently built frontend are distinct payloads.
  for (const path of [
    'LICENSE',
    'LICENSE.upstream',
    'lib/index.js',
    'lib/main.js',
    'lib/host.js',
    'lib/client.js',
    'lib/preload-app.cjs',
    'lib/preload-shell.cjs',
    'lib/preload-extension.cjs',
    'lib/native-ui/index.html',
    'cordis.patch.yml',
    'product-update.json',
    'scripts/node-bin/node',
    'scripts/node-bin/node.cmd',
    'assets/tray-iconTemplate.png',
    'assets/tray-icon-blue.png',
  ]) {
    if (!existsSync(join(root, path)))
      throw new Error(`Missing SuperDsh payload: ${path}`)
  }
  const inside = (path: string): boolean => {
    const fromRoot = relative(root, path)
    return (
      !isAbsolute(fromRoot) &&
      fromRoot !== '..' &&
      !fromRoot.startsWith('../') &&
      !fromRoot.startsWith('..\\')
    )
  }
  const queued = [join(root, 'package.json')]
  const visited = new Set<string>()
  while (queued.length) {
    const manifest = realpathSync(queued.pop()!)
    if (visited.has(manifest)) continue
    visited.add(manifest)
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    // Required peers are runtime edges too: a plugin whose peer is absent throws on import and the
    // Host reports it as an entry that did not activate, long after packaging reported success.
    // They are the packages most easily missed, because the workspace resolves them from the
    // repository root even when this application never declares them.
    const optionalPeers = data.peerDependenciesMeta ?? {}
    const required = [
      ...Object.keys(data.dependencies ?? {}),
      ...Object.keys(data.peerDependencies ?? {}).filter(
        (name) => optionalPeers[name]?.optional !== true,
      ),
    ]
    for (const name of required) {
      let parent = dirname(manifest)
      let found: string | undefined
      while (inside(parent)) {
        const candidate = join(parent, 'node_modules', name, 'package.json')
        if (existsSync(candidate)) {
          found = realpathSync(candidate)
          break
        }
        if (parent === root) break
        parent = dirname(parent)
      }
      if (!found) {
        if (Object.hasOwn(data.optionalDependencies ?? {}, name)) continue
        throw new Error(
          `Missing packaged dependency ${name} required by ${data.name}`,
        )
      }
      if (!inside(found))
        throw new Error(`Packaged dependency escapes the application: ${name}`)
      queued.push(found)
    }
  }
  for (const path of [
    'node_modules/@superdsh/core/lib/backend/host.js',
    'node_modules/@superdsh/harness/lib/host.js',
    'node_modules/@superdsh/harness/cordis.patch.yml',
    'node_modules/@superdsh/harness/host.cordis.patch.yml',
    'node_modules/@superdsh/core/lib/contracts/desktop-contract.js',
    'node_modules/@superdsh/ui/dist/index.html',
    'node_modules/@superdsh/ui/dist/compatibility.html',
    'node_modules/@superdsh/ui/client-manifest.json',
  ]) {
    if (!existsSync(join(root, path)))
      throw new Error(`Missing separated runtime payload: ${path}`)
  }
  const frontendRoot = join(root, 'node_modules/@superdsh/ui')
  const manifest = JSON.parse(
    readFileSync(join(frontendRoot, 'client-manifest.json'), 'utf8'),
  )
  if (
    manifest.schemaVersion !== 1 ||
    manifest.harnessVersion !== '0.1.7-alpha.2' ||
    !manifest.modules ||
    !Object.keys(manifest.modules).length
  ) {
    throw new Error('Packaged frontend artifact manifest is incompatible')
  }
  for (const [name, value] of Object.entries(manifest.modules)) {
    const path = (value as { path?: unknown }).path
    if (typeof path !== 'string' || isAbsolute(path))
      throw new Error(`Invalid packaged frontend module ${name}`)
    const file = realpathSync(join(frontendRoot, path))
    const withinFrontend = relative(realpathSync(frontendRoot), file)
    if (
      isAbsolute(withinFrontend) ||
      withinFrontend === '..' ||
      withinFrontend.startsWith('../') ||
      withinFrontend.startsWith('..\\')
    ) {
      throw new Error(`Packaged frontend module escapes frontend: ${name}`)
    }
  }
}
export default function afterPack(context: PackContext): void {
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, 'SuperDsh.app/Contents/Resources')
      : join(context.appOutDir, 'resources')
  if (existsSync(join(resources, 'app.asar')))
    throw new Error('SuperDsh requires its declared asar:false runtime layout')
  verifyNextPayload(join(resources, 'app'))
}
