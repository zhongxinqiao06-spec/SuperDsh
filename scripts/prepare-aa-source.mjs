import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const retired = ['web-next', 'server', 'android']
const markers = [
  'apps/admin/package.json',
  'apps/server/pyproject.toml',
  'apps/android/settings.gradle.kts',
]

/** Keep the pinned upstream engine sources without duplicate product applications. */
export function prepareAaSource(root, { checkOnly = false } = {}) {
  const source = join(root, 'agents-anywhere')
  const manifest = JSON.parse(
    readFileSync(join(root, 'vendor/agents-anywhere/apps-source.json'), 'utf8'),
  )
  const git = (args, input) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
    }).trim()
  if (!existsSync(join(source, '.git')))
    throw new Error(
      'Initialize submodules first: git submodule update --init --recursive',
    )
  if (lstatSync(source).isSymbolicLink())
    throw new Error('AA source must not be a symlink')
  if (git(['rev-parse', 'HEAD']) !== manifest.commit)
    throw new Error(
      'AA checkout differs from the recorded application import commit',
    )
  if (git(['status', '--porcelain', '--untracked-files=no']))
    throw new Error(
      'AA has tracked changes; preserve them before preparing its source layout',
    )
  for (const marker of markers) {
    if (!existsSync(join(root, marker)))
      throw new Error(`Missing owned application: ${marker}`)
  }
  const patterns =
    ['/*', ...retired.map((name) => `!/${name}/`)].join('\n') + '\n'
  if (!checkOnly)
    git(['sparse-checkout', 'set', '--no-cone', '--stdin'], patterns)
  let actual
  try {
    actual = git(['sparse-checkout', 'list'])
  } catch {
    throw new Error(
      'AA sparse checkout is not prepared. Run yarn sources:prepare.',
    )
  }
  if (actual.replaceAll('\r', '') !== patterns.trim())
    throw new Error('AA sparse rules differ. Run yarn sources:prepare.')
  for (const name of retired) {
    if (existsSync(join(source, name)))
      throw new Error(
        `Old AA directory remains: ${name}. Back up and remove its untracked build/cache files; those local files were preserved.`,
      )
  }
  if (git(['status', '--porcelain', '--untracked-files=no']))
    throw new Error('AA source layout left unexpected tracked changes')
  return { commit: manifest.commit, applications: markers.length }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2)
  if (args.some((value) => value !== '--check'))
    throw new Error('Usage: node scripts/prepare-aa-source.mjs [--check]')
  try {
    const result = prepareAaSource(resolve(import.meta.dirname, '..'), {
      checkOnly: args.includes('--check'),
    })
    console.log(
      `AA source: ${result.applications} owned applications; pinned ${result.commit.slice(0, 12)} has no retired app directories.`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
