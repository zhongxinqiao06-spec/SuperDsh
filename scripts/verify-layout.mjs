import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  architecturePackages,
  isDshPackage,
  readOwnedWorkspaces,
  verifyDependencyBoundaries,
} from './workspace-layout.mjs'

const root = resolve(import.meta.dirname, '..')
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const fail = (message) => {
  throw new Error(`verify-layout: ${message}`)
}
if (process.argv.length > 2) fail('usage: node scripts/verify-layout.mjs')
const workspace = readJson('package.json')
const upstream = readJson('upstream.json')
const upstreamPackage = readJson('deepseek-harness/package.json')
const packages = readOwnedWorkspaces(root, workspace)
const byPath = new Map(packages.map((row) => [row.path, row.manifest]))
if (workspace.packageManager !== 'yarn@4.18.0')
  fail('the product workspace must pin yarn@4.18.0')
for (const [path, name] of Object.entries(architecturePackages)) {
  if (byPath.get(path)?.name !== name)
    fail(`required owned workspace ${path} must declare ${name}`)
}
for (const { path, manifest } of packages) {
  if (manifest.packageManager !== undefined)
    fail(`${path} must inherit the root Yarn release`)
  for (const filename of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (existsSync(resolve(root, path, filename)))
      fail(`${path}/${filename} must not exist`)
  }
}
for (const filename of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  if (existsSync(resolve(root, filename))) fail(`${filename} must not exist`)
}
verifyDependencyBoundaries(workspace, packages)
for (const name of ['dsh-community-fabric', 'dsh-community-market']) {
  if (byPath.get(name)?.name !== name) fail(`missing shared ${name} workspace`)
}
const claudePath = resolve(root, 'CLAUDE.md')
const claudeTarget = lstatSync(claudePath).isSymbolicLink()
  ? readlinkSync(claudePath)
  : readFileSync(claudePath, 'utf8').trim()
if (claudeTarget !== 'AGENTS.md')
  fail('CLAUDE.md must point at the outer AGENTS.md')
if (
  upstream.activeChannel !== 'stable' ||
  JSON.stringify(Object.keys(upstream.channels ?? {})) !== '["stable"]'
)
  fail('upstream must declare one canonical stable runtime channel')
const active = upstream.channels.stable
if (
  run('git', [
    'config',
    '-f',
    '.gitmodules',
    '--get',
    'submodule.deepseek-harness.path',
  ]) !== 'deepseek-harness'
)
  fail('Harness submodule path changed')
if (
  run('git', [
    'config',
    '-f',
    '.gitmodules',
    '--get',
    'submodule.deepseek-harness.url',
  ]) !== upstream.repository
)
  fail('Harness submodule URL differs from upstream.json')
if (!upstreamPackage.packageManager?.startsWith('pnpm@'))
  fail('the Harness submodule must retain pnpm')
const [mode, object] = run('git', [
  'ls-files',
  '--stage',
  '--',
  'deepseek-harness',
]).split(/\s+/u)
if (mode !== '160000' || object !== active.commit)
  fail('Harness gitlink must match the pinned commit')
const upstreamDir = resolve(root, 'deepseek-harness')
if (run('git', ['rev-parse', 'HEAD'], upstreamDir) !== active.commit)
  fail('Harness checkout differs from the pinned commit')
if (run('git', ['status', '--porcelain'], upstreamDir) !== '')
  fail('deepseek-harness contains local changes')
if (
  run('git', ['remote', 'get-url', 'origin'], upstreamDir) !==
  upstream.repository
)
  fail('Harness origin differs from upstream.json')
if (upstreamPackage.version !== active.sourceVersion)
  fail('Harness source version differs from upstream.json')
for (const { path, manifest } of packages.filter(
  (row) =>
    /^(?:apps|packages|plugins)\//u.test(row.path) ||
    row.path === 'dsh-community-market',
)) {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (isDshPackage(name) && range !== active.runtimePackageVersion)
        fail(`${path} ${field}.${name} must use the pinned runtime family`)
    }
  }
}
process.stdout.write(
  `verify-layout: SuperDsh workspaces and Harness ${active.commit.slice(0, 10)} verified\n`,
)
