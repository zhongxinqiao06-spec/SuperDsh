import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const paths = {}
// Test fixtures intentionally exercise the thin plugin's pinned Host and
// Client contract tree, even though implementations now live under desktop.
const scope = join(root, 'node_modules/@deepseek-ai')
for (const name of readdirSync(scope)) {
  const directory = join(scope, name)
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const [subpath, value] of Object.entries(
    manifest.exports ?? { '.': { types: manifest.types } },
  )) {
    const types = value && typeof value === 'object' ? value.types : undefined
    if (
      typeof types !== 'string' ||
      !types.endsWith('.d.ts') ||
      subpath.includes('*')
    )
      continue
    const target = resolve(directory, types)
    if (!existsSync(target))
      throw new Error(`Missing pinned test declaration: ${target}`)
    paths[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [target]
  }
}
const configPath = join(root, 'tsconfig.tests.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
  )
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  root,
  { paths },
  configPath,
)
const program = ts.createProgram(parsed.fileNames, parsed.options)
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
  `Market test typecheck: ${parsed.fileNames.length} test files, ${diagnostics.length} diagnostics\n`,
)
process.exitCode = diagnostics.length ? 1 : 0
