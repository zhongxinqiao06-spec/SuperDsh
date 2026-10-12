import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const excluded = new Set([
  'node_modules',
  'coverage',
  '.vite',
  '.cache',
  '.superdsh',
  '.next',
  'generated',
])
const buildOutput =
  /^(?:apps\/admin\/(?:out|\.next-[^/]+)|apps\/desktop(?:\/core|\/plugins\/harness)?\/(?:lib|dist)|apps\/desktop\/ui\/(?:client|dist|native-ui)|dsh-community-market\/(?:lib|dist))(?:\/|$)/u
const generated =
  /(?:^|\/)(?:next-env\.d\.ts|api-catalog\.ts|slot-catalog\.ts|client-manifest\.json|build-sources\.json|source-manifest\.json|module-packages\.json|migration-paths\.json|tsconfig\.paths\.json)$/u
const extensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.yml',
  '.yaml',
])
export function ownedCodeFiles(directory = root) {
  const walk = (path) => {
    const local = relative(directory, path).replaceAll('\\', '/')
    if (buildOutput.test(local)) return []
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return []
    if (!lstatSync(path).isDirectory())
      return extensions.has(extname(path)) &&
        !generated.test(path.replaceAll('\\', '/'))
        ? [path]
        : []
    return readdirSync(path)
      .filter((name) => !excluded.has(name))
      .flatMap((name) => walk(join(path, name)))
  }
  const files = [
    'apps/admin',
    'apps/desktop',
    'apps/server/agent-runtime',
    'apps/server/scripts',
    'apps/server/docker',
    'dsh-community-market',
    'scripts',
    '.github/workflows',
  ].flatMap((path) => walk(join(directory, path)))
  for (const name of readdirSync(directory))
    if (
      /^(?:tsconfig.*\.json|eslint\.config\.mjs|\.prettierrc\.json)$/u.test(
        name,
      )
    )
      files.push(join(directory, name))
  return [...new Set(files)].sort()
}

export async function runCodeQuality(mode, directory = root) {
  if (mode === 'format-check') mode = 'format:check'
  const files = ownedCodeFiles(directory)
  if (!files.length) throw new Error('No owned code files found')
  if (mode === 'lint') {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: directory })
    const results = await eslint.lintFiles(
      files.filter((path) => /\.[cm]?[jt]sx?$/u.test(path)),
    )
    const formatter = await eslint.loadFormatter('stylish')
    const output = formatter.format(results)
    if (output) process.stdout.write(output)
    return results.every((result) => result.errorCount === 0) ? 0 : 1
  }
  if (mode !== 'format' && mode !== 'format:check')
    throw new Error(
      'usage: node scripts/code-quality.mjs lint|format|format:check',
    )
  const prettier = await import('prettier')
  let mismatches = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const options = { ...(await prettier.resolveConfig(file)), filepath: file }
    // Some TypeScript return types/chains need a second Prettier pass after
    // a large layout change. Always write the stable result used by CI.
    let formatted = source
    for (let pass = 0; pass < 4; pass++) {
      const next = await prettier.format(formatted, options)
      if (next === formatted) break
      formatted = next
      if (pass === 3) throw new Error(`Formatting did not converge: ${file}`)
    }
    if (formatted === source) continue
    mismatches++
    if (mode === 'format') writeFileSync(file, formatted)
    else process.stdout.write(`${relative(directory, file)}\n`)
  }
  process.stdout.write(
    `${mode}: ${files.length} files, ${mismatches} ${mode === 'format' ? 'formatted' : 'differences'}\n`,
  )
  return mode === 'format:check' && mismatches ? 1 : 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await runCodeQuality(process.argv[2])
