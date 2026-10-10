import { createHash } from 'node:crypto'
import { existsSync, readFileSync, watch } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle, type UserConfig } from 'tsdown'
import { build as viteBuild } from 'vite'
import { clientConfig } from '../build/client-bundle.ts'
import documentPreviewConfig from '../src/features/sidebar-documentpreview/tsdown.config.ts'
import { ownedSourcePlugin, readSourceManifest } from './source-ownership.mjs'
import { createWebConfig } from './web-config.ts'
import { createNativeConfig } from './native-config.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
process.env.DSH_CLIENT_TITLE ??= 'SuperDsh'
process.env.DSH_CLIENT_BUILD_PROFILE ??= 'superdsh'
process.env.DSH_CLIENT_VERSION ??= '0.1.0'
process.env.DSH_CLIENT_COMMIT_HASH ??= '0000000'

async function build(): Promise<void> {
  const manifest = readSourceManifest(root)
  // Derive admission from the same source manifest as the emitted bundles. Avoid
  // rewriting an unchanged file so this generated input cannot loop the watcher.
  const ownedModulesPath = resolve(root, 'src/owned-modules.json')
  const ownedModulesSource =
    JSON.stringify(Object.keys(manifest.modules).sort(), null, 2) + '\n'
  if (
    !existsSync(ownedModulesPath) ||
    readFileSync(ownedModulesPath, 'utf8') !== ownedModulesSource
  ) {
    await writeFile(ownedModulesPath, ownedModulesSource)
  }
  const records: Record<string, string[]> = {}
  const modules: Record<string, object> = {}
  const pending = Object.entries(manifest.modules) as [
    string,
    {
      entry: string
      inject?: string[]
      external?: string[]
      immediately?: boolean
    },
  ][]
  for (const [id, row] of pending) {
    const inputs = new Set<string>()
    const special =
      id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
        ? documentPreviewConfig({}).find((config) =>
            config.name?.endsWith('/client'),
          )
        : undefined
    const config: UserConfig =
      special ?? clientConfig(id, resolve(root, row.entry))
    const relativeOutput = `client/${id.replace('@deepseek-ai/', '').replace('@superdsh/', 'superdsh-')}`
    await bundle({
      ...config,
      config: false,
      entry: { client: resolve(root, row.entry) },
      outDir: resolve(root, relativeOutput),
      plugins: [config.plugins, ownedSourcePlugin(root, manifest, inputs)],
      logLevel: 'warn',
      report: false,
    })
    records[id] = [...inputs].sort()
    modules[id] = {
      path: `${relativeOutput}/client.js`,
      ...(row.inject === undefined ? {} : { inject: row.inject }),
      external: row.external ?? [],
      immediately: row.immediately === true,
    }
  }
  const staticInputs = new Set<string>()
  await viteBuild(createWebConfig(root, manifest, staticInputs))
  records['@superdsh/ui/static'] = [...staticInputs].sort()
  const nativeInputs = new Set<string>()
  await viteBuild(createNativeConfig(root, manifest, nativeInputs))
  records['@superdsh/ui/native'] = [...nativeInputs].sort()
  const hash = createHash('sha256')
  for (const input of [...new Set(Object.values(records).flat())]
    .filter(
      (file) => file.startsWith('src/') || file.startsWith('../core/lib/'),
    )
    .sort()) {
    if (!existsSync(resolve(root, input))) continue
    hash.update(input).update(readFileSync(resolve(root, input)))
  }
  const sourceDigest = hash.digest('hex')
  await mkdir(root, { recursive: true })
  await writeFile(
    resolve(root, 'build-sources.json'),
    JSON.stringify(
      { schemaVersion: 1, sourceDigest, modules: records },
      null,
      2,
    ) + '\n',
  )
  const artifact = {
    schemaVersion: 1,
    harnessVersion: manifest.harnessVersion,
    sourceDigest,
    staticRoot: 'dist',
    buildSources: 'build-sources.json',
    modules,
  }
  await writeFile(
    resolve(root, 'client-manifest.json.tmp'),
    JSON.stringify(artifact, null, 2) + '\n',
  )
  await rename(
    resolve(root, 'client-manifest.json.tmp'),
    resolve(root, 'client-manifest.json'),
  )
  console.log(
    `SuperDsh frontend: built ${pending.length} owned browser modules and static platform (${sourceDigest.slice(0, 12)})`,
  )
}

await build()
if (process.argv.includes('--watch')) {
  let building = false,
    pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const rebuild = async (): Promise<void> => {
    if (building) {
      pending = true
      return
    }
    building = true
    do {
      pending = false
      try {
        await build()
      } catch (error) {
        console.error('Frontend rebuild failed:', error)
      }
    } while (pending)
    building = false
  }
  const changed = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void rebuild()
    }, 150)
  }
  for (const dir of ['src', 'public', 'scripts', 'build'])
    watch(resolve(root, dir), { recursive: true }, changed)
  // Core's browser-safe state/contract code is inlined into the UI bundles.
  // Rebuild those bundles after Core emits a new generation as well.
  if (existsSync(resolve(root, '../core/lib')))
    watch(resolve(root, '../core/lib'), { recursive: true }, changed)
  for (const file of [
    'index.html',
    'compatibility.html',
    'source-manifest.json',
    'module-packages.json',
  ])
    watch(resolve(root, file), changed)
  console.log(
    'Watching owned frontend source; successful rebuilds atomically replace client-manifest.json.',
  )
}
