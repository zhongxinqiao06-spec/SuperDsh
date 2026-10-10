import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ui = join(root, 'apps/desktop/ui')
const harness = join(root, 'apps/desktop/plugins/harness')
const require = createRequire(join(ui, 'package.json'))
const ts = require('typescript')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const paths = {}
const declarations = new Map()
const aliases = {
  ...readJson(join(ui, 'type-aliases.json')),
  ...Object.fromEntries(
    Object.entries(readJson(join(ui, 'source-manifest.json')).exports).filter(
      ([, path]) => /\.[cm]?tsx?$/u.test(path),
    ),
  ),
}

// Pinned package declarations describe Host RPC contracts; browser runtime
// imports continue to resolve exclusively through source-manifest.json.
for (const folder of [
  join(harness, 'node_modules/@deepseek-ai'),
  join(ui, 'node_modules/@deepseek-ai'),
]) {
  if (!existsSync(folder))
    throw new Error(`Install workspaces before typechecking: ${folder}`)
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const directory = join(folder, entry.name)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    const exports = manifest.exports ?? { '.': { types: manifest.types } }
    for (const [subpath, conditions] of Object.entries(exports)) {
      const types =
        typeof conditions === 'object' && conditions !== null
          ? conditions.types
          : undefined
      if (
        typeof types !== 'string' ||
        !types.endsWith('.d.ts') ||
        subpath.includes('*')
      )
        continue
      const file = resolve(directory, types)
      if (!existsSync(file))
        throw new Error(`Missing pinned declaration: ${file}`)
      paths[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [file]
      const name = manifest.name + (subpath === '.' ? '' : subpath.slice(1))
      const source = aliases[name]
      if (source)
        declarations.set(
          file.replaceAll('\\', '/').toLowerCase(),
          resolve(ui, source),
        )
    }
  }
}
// Include type-only contracts as well as runtime entry points to prevent
// duplicate Context and slot augmentations from installed browser declarations.
for (const [name, target] of Object.entries(aliases)) {
  const file = resolve(ui, target)
  if (!existsSync(file))
    throw new Error(`Missing owned type alias ${name}: ${target}`)
  paths[name] = [file]
}
const configPath = join(ui, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
  )
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  ui,
  { paths },
  configPath,
)
const host = ts.createCompilerHost(parsed.options)
host.resolveModuleNames = (names, containingFile) =>
  names.map((name) => {
    const resolved = ts.resolveModuleName(
      name,
      containingFile,
      parsed.options,
      host,
    ).resolvedModule
    if (!resolved) return undefined
    const source = declarations.get(
      resolved.resolvedFileName.replaceAll('\\', '/').toLowerCase(),
    )
    return source
      ? {
          resolvedFileName: source,
          extension: source.endsWith('.tsx')
            ? ts.Extension.Tsx
            : ts.Extension.Ts,
          isExternalLibraryImport: false,
        }
      : resolved
  })
const program = ts.createProgram(parsed.fileNames, parsed.options, host)
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length)
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  )
process.stdout.write(
  `UI typecheck: ${parsed.fileNames.length} source/tooling files, ${diagnostics.length} diagnostics\n`,
)
process.exitCode = diagnostics.length ? 1 : 0
