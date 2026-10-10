import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  architecturePackages,
  readJson,
  readOwnedWorkspaces,
  verifyDependencyBoundaries,
} from './workspace-layout.mjs'

const fail = (message) => {
  throw new Error(`verify-superdsh-layout: ${message}`)
}
const legacy =
  /(?:^|[/\\])(?:dsh-plugin-desktop(?:-beta)?|dsh-desktop-next)(?:[/\\]|$)/u
const local = (parent, child) => {
  const path = relative(parent, child)
  return (
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith('../') &&
    !path.startsWith('..\\')
  )
}
const basePackage = (name) =>
  name.startsWith('@')
    ? name.split('/').slice(0, 2).join('/')
    : name.split('/')[0]
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
)
const assemblyResource = (name) =>
  /^@superdsh\/(?:desktop\/package\.json|ui\/(?:package\.json|client-manifest\.json|dist\/index\.html|native-ui\/index\.html))$/u.test(
    name,
  )
function files(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink())
      fail(
        `source/build tree contains a symlink: ${join(directory, entry.name)}`,
      )
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
export function imports(text) {
  // Tokenize strings/comments first: bundled syntax grammars contain examples
  // such as `from "x"` that are data, not runtime module dependencies.
  const tokens = [
    ...text.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/gu,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*'))
  const value = (token) =>
    token && /^["']/u.test(token) ? token.slice(1, -1) : undefined
  const result = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (
      !['import', 'export', 'require'].includes(token) ||
      tokens[index - 1] === '.'
    )
      continue
    let next = index + 1
    if (
      token === 'require' &&
      tokens[next] === '.' &&
      tokens[next + 1] === 'resolve'
    )
      next += 2
    if (tokens[next] === '(' && value(tokens[next + 1]) !== undefined)
      result.push(value(tokens[next + 1]))
    else if (token === 'import' && value(tokens[next]) !== undefined)
      result.push(value(tokens[next]))
    else if (
      token === 'import' ||
      (token === 'export' && ['*', '{', 'type'].includes(tokens[next]))
    ) {
      for (
        let cursor = next;
        cursor < Math.min(tokens.length, next + 200) && tokens[cursor] !== ';';
        cursor++
      ) {
        if (
          tokens[cursor] === 'from' &&
          value(tokens[cursor + 1]) !== undefined
        ) {
          result.push(value(tokens[cursor + 1]))
          break
        }
      }
    }
  }
  return result
}
function artifact(root, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    !local(root, resolve(root, path))
  )
    fail(`artifact escapes its package: ${String(path)}`)
  const file = resolve(root, path)
  if (
    !existsSync(file) ||
    !lstatSync(file).isFile() ||
    !local(realpathSync(root), realpathSync(file))
  )
    fail(`missing or unsafe built artifact: ${file}`)
  return file
}
function runtimeExports(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'types' ? [] : runtimeExports(child),
  )
}
function checkDefaultCommands(workspace) {
  const scripts = workspace.scripts ?? {},
    visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return
    visited.add(name)
    const command = scripts[name]
    if (typeof command !== 'string') fail(`missing default script ${name}`)
    if (/\bdsh-plugin-desktop(?:-beta)?\b|\bdsh-desktop-next\b/u.test(command))
      fail(`default command ${name} still launches or checks a legacy desktop`)
    for (const match of command.matchAll(/\byarn(?:\s+run)?\s+([\w:-]+)/gu)) {
      if (match[1] !== 'workspace' && Object.hasOwn(scripts, match[1]))
        visit(match[1])
    }
  }
  for (const name of ['dev', 'build', 'typecheck', 'test', 'check']) visit(name)
}
function checkFrontend(root, version, sourceOnly) {
  const frontend = join(root, 'apps/desktop/ui'),
    source = readJson(join(frontend, 'source-manifest.json'))
  if (
    source.schemaVersion !== 1 ||
    source.harnessVersion !== version ||
    !source.modules ||
    !Object.keys(source.modules).length
  )
    fail('frontend source manifest must match the pinned runtime')
  for (const [id, row] of Object.entries(source.modules)) {
    if (typeof row.entry !== 'string' || !row.entry.startsWith('src/'))
      fail(`frontend ${id} must have an owned source entry`)
    artifact(frontend, row.entry)
  }
  if (sourceOnly) return
  const built = readJson(artifact(frontend, 'client-manifest.json'))
  if (
    built.schemaVersion !== 1 ||
    built.harnessVersion !== version ||
    !built.modules
  )
    fail('frontend artifact manifest is incompatible')
  if (
    JSON.stringify(Object.keys(built.modules).sort()) !==
    JSON.stringify(Object.keys(source.modules).sort())
  )
    fail('frontend source/artifact module IDs differ')
  artifact(frontend, `${built.staticRoot}/index.html`)
  for (const [id, row] of Object.entries(built.modules)) {
    artifact(frontend, row.path)
    for (const field of ['inject', 'external']) {
      if (
        JSON.stringify(row[field] ?? []) !==
        JSON.stringify(source.modules[id][field] ?? [])
      )
        fail(`frontend ${id} ${field} metadata differs from source`)
    }
    for (const dependency of row.external ?? []) {
      if (
        dependency.startsWith('@deepseek-ai/dsh') &&
        !Object.hasOwn(built.modules, dependency.replace(/\/client$/u, ''))
      )
        fail(`frontend module ${id} is missing external ${dependency}`)
    }
  }
  const records = readJson(artifact(frontend, built.buildSources))
  if (records.sourceDigest !== built.sourceDigest || !records.modules)
    fail('frontend build-input record differs from its artifact manifest')
  const inputs = [...new Set(Object.values(records.modules).flat())].sort()
  const hash = createHash('sha256')
  for (const input of inputs) {
    if (
      typeof input !== 'string' ||
      /(?:^|[/\\])deepseek-harness[/\\]|node_modules[/\\]@deepseek-ai[/\\]dsh-/u.test(
        input,
      )
    )
      fail(`frontend build used an upstream runtime artifact: ${String(input)}`)
    if (input.startsWith('src/'))
      hash.update(input).update(readFileSync(artifact(frontend, input)))
    if (input.startsWith('../core/lib/')) {
      const clientArtifact = /^\.\.\/core\/lib\/(?:client|contracts)\//u.test(
        input,
      )
      const sharedChunk = /^\.\.\/core\/lib\/[^/]+\.js$/u.test(input)
      if (!clientArtifact && !sharedChunk)
        fail(`frontend bundled a non-browser core artifact: ${input}`)
      const contents = readFileSync(
        artifact(
          join(root, 'apps/desktop/core'),
          input.slice('../core/'.length),
        ),
      )
      if (
        imports(contents.toString('utf8')).some(
          (name) =>
            name.startsWith('node:') ||
            builtins.has(name) ||
            /^(?:electron|@superdsh\/harness|@deepseek-ai\/dsh(?:-|$))/u.test(
              name,
            ),
        )
      )
        fail(`frontend Core artifact imports a server dependency: ${input}`)
      hash.update(input).update(contents)
    }
  }
  if (hash.digest('hex') !== built.sourceDigest)
    fail('frontend owned sources changed after the last build')
}

export function verifySuperdshLayout(root, { sourceOnly = false } = {}) {
  root = resolve(root)
  const workspace = readJson(join(root, 'package.json'))
  const packages = readOwnedWorkspaces(root, workspace)
  verifyDependencyBoundaries(workspace, packages)
  const own = new Map(
    packages
      .filter((row) => row.manifest.name.startsWith('@superdsh/'))
      .map((row) => [row.manifest.name, row]),
  )
  for (const [path, name] of Object.entries(architecturePackages)) {
    if (own.get(name)?.path !== path)
      fail(`required package ${name} must live at ${path}`)
  }
  const requiredEdges = {
    '@superdsh/desktop': [
      '@superdsh/core',
      '@superdsh/ui',
      '@superdsh/harness',
    ],
    '@superdsh/core': ['@superdsh/harness'],
  }
  const harness = own.get('@superdsh/harness').manifest
  if (harness.dependencies?.['@superdsh/core'])
    fail(
      'Harness must bundle pure core contracts from a development dependency, never create a runtime cycle',
    )
  if (harness.devDependencies?.['@superdsh/core'] !== 'workspace:*')
    fail('Harness must declare its build-time core contracts dependency')
  for (const [owner, names] of Object.entries(requiredEdges)) {
    for (const name of names)
      if (
        !own.get(owner).manifest.dependencies?.[name]?.startsWith('workspace:')
      )
        fail(`${owner} must declare its runtime dependency ${name}`)
  }
  checkDefaultCommands(workspace)
  const upstream = readJson(join(root, 'upstream.json')),
    version = upstream.channels[upstream.activeChannel].runtimePackageVersion
  const selector = `@deepseek-ai/dsh-client-modules@npm:${version}`
  for (const name of [selector, selector.replace('@npm:', '@npm:^')]) {
    const value = workspace.resolutions?.[name]
    if (
      typeof value !== 'string' ||
      !value.includes('vendor/dsh-runtime/') ||
      !value.endsWith('#./patches/superdsh-client-modules.patch')
    )
      fail(
        'the owned frontend requires the vendored SuperDsh client registry patch',
      )
  }
  artifact(root, 'patches/superdsh-client-modules.patch')
  for (const { path, manifest } of own.values()) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const name of Object.keys(manifest[field] ?? {}))
        if (legacy.test(name))
          fail(`${path} declares a dependency on a legacy desktop`)
    }
    for (const file of files(join(root, path, 'src')).filter((file) =>
      /\.[cm]?[jt]sx?$/u.test(file),
    )) {
      for (const name of imports(readFileSync(file, 'utf8'))) {
        const target = name.startsWith('.')
          ? relative(root, resolve(dirname(file), name)).replaceAll('\\', '/')
          : name
        if (
          legacy.test(target) ||
          /(?:^|\/)deepseek-harness(?:\/|$)/u.test(target) ||
          /^@superdsh\/(?:frontend|backend|contracts|desktop-ui)(?:\/|$)/u.test(
            target,
          )
        )
          fail(
            `${relative(root, file)} imports a legacy or upstream source: ${name}`,
          )
        const assembledResource = assemblyResource(name)
        if (
          manifest.name === '@superdsh/core' &&
          !assembledResource &&
          (/^@superdsh\/(?:ui|desktop)(?:\/|$)/u.test(name) ||
            /^apps\/desktop\/ui\//u.test(target))
        )
          fail(`core must not import presentation or assembly: ${name}`)
        const coreImplementation =
          /^@superdsh\/core(?:$|\/(?!contracts(?:\/|$)))/u.test(name) ||
          /^apps\/desktop\/core\/(?!src\/contracts\/)/u.test(target)
        const browserClient =
          /^@superdsh\/core\/client(?:\/|$)/u.test(name) ||
          /^apps\/desktop\/core\/src\/client\//u.test(target)
        if (
          manifest.name === '@superdsh/ui' &&
          coreImplementation &&
          !browserClient
        )
          fail(
            `UI must import only pure core contracts or browser client APIs: ${name}`,
          )
        if (manifest.name === '@superdsh/harness' && coreImplementation)
          fail(`Harness must import only pure core contracts: ${name}`)
        if (
          file.replaceAll('\\', '/').includes('/core/src/client/') &&
          (name.startsWith('node:') ||
            builtins.has(name) ||
            /^(?:electron|@superdsh\/harness|@deepseek-ai\/dsh(?:-|$))/u.test(
              name,
            ) ||
            (coreImplementation && !browserClient))
        )
          fail(`browser core client imports a server implementation: ${name}`)
        if (
          file.replaceAll('\\', '/').includes('/core/src/contracts/') &&
          (name.startsWith('node:') ||
            builtins.has(name) ||
            /^(?:electron|@superdsh\/(?:ui|desktop|harness)|@deepseek-ai\/dsh(?:-|$))/u.test(
              name,
            ) ||
            coreImplementation)
        )
          fail(
            `shared contracts must not depend on a runtime implementation: ${name}`,
          )
      }
    }
    if (sourceOnly) continue
    const directory = join(root, path)
    for (const entry of [
      manifest.main,
      ...runtimeExports(manifest.exports),
      manifest.dsh?.bundle?.patch,
    ].filter(Boolean)) {
      if (!entry.includes('*')) artifact(directory, entry)
    }
    for (const file of files(join(directory, 'lib')).filter(
      (file) =>
        /\.[cm]?js$/u.test(file) &&
        !file.replaceAll('\\', '/').includes('/native-ui/') &&
        !file.replaceAll('\\', '/').endsWith('/client.js'),
    )) {
      for (const name of imports(readFileSync(file, 'utf8'))) {
        if (
          name.startsWith('.') ||
          name.startsWith('#') ||
          name.startsWith('node:') ||
          builtins.has(name) ||
          name === 'electron'
        )
          continue
        if (manifest.name === '@superdsh/core' && assemblyResource(name))
          continue
        const dependency = basePackage(name)
        if (
          dependency !== manifest.name &&
          !manifest.dependencies?.[dependency] &&
          !manifest.optionalDependencies?.[dependency] &&
          !manifest.peerDependencies?.[dependency]
        )
          fail(
            `${relative(root, file)} imports undeclared runtime dependency ${dependency}`,
          )
      }
    }
  }
  if (!sourceOnly)
    for (const path of [
      'apps/desktop/core/lib/main/main.js',
      'apps/desktop/core/lib/preload/preload-app.cjs',
      'apps/desktop/core/lib/preload/preload-shell.cjs',
      'apps/desktop/ui/native-ui/index.html',
      'apps/desktop/core/lib/backend/host.js',
      'apps/desktop/plugins/harness/lib/host.js',
      'apps/desktop/plugins/harness/host.cordis.patch.yml',
    ])
      artifact(root, path)
  checkFrontend(root, version, sourceOnly)
  return { packages: own.size, sourceOnly }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.slice(2).some((arg) => arg !== '--source-only'))
    fail('usage: node scripts/verify-superdsh-layout.mjs [--source-only]')
  const result = verifySuperdshLayout(resolve(import.meta.dirname, '..'), {
    sourceOnly: process.argv.includes('--source-only'),
  })
  process.stdout.write(
    `verify-superdsh-layout: ${result.packages} owned packages, source boundaries${result.sourceOnly ? '' : ', runtime imports and frontend artifacts'} verified\n`,
  )
}
