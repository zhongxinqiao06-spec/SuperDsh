import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const supportWorkspaces = [
  'dsh-community-fabric',
  'dsh-community-market',
]
export const architecturePackages = {
  'apps/admin': '@superdsh/admin',
  'apps/desktop': '@superdsh/desktop',
  'apps/desktop/core': '@superdsh/core',
  'apps/desktop/ui': '@superdsh/ui',
  'apps/desktop/plugins/harness': '@superdsh/harness',
}
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const isDshPackage = (name) =>
  name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

/** Only the explicitly owned top-level trees are Yarn workspaces. Never walk submodules. */
export function readOwnedWorkspaces(
  root,
  workspace = readJson(join(root, 'package.json')),
) {
  if (!Array.isArray(workspace.workspaces))
    throw new Error('Root workspaces must be an explicit array')
  const paths = new Set()
  for (const pattern of workspace.workspaces) {
    if (supportWorkspaces.includes(pattern)) paths.add(pattern)
    else if (pattern === 'apps/*') {
      const tree = pattern.slice(0, -2)
      for (const entry of readdirSync(join(root, tree), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink())
          throw new Error(
            `Workspace directory must not be a symlink: ${tree}/${entry.name}`,
          )
        if (
          entry.isDirectory() &&
          existsSync(join(root, tree, entry.name, 'package.json'))
        ) {
          const path = `${tree}/${entry.name}`
          if (!Object.hasOwn(architecturePackages, path))
            throw new Error(`Unregistered owned workspace: ${path}`)
          paths.add(path)
        }
      }
    } else if (Object.hasOwn(architecturePackages, pattern)) paths.add(pattern)
    else
      throw new Error(
        `Workspace pattern crosses the owned package boundary: ${pattern}`,
      )
  }
  const names = new Set()
  return [...paths].sort().map((path) => {
    if (lstatSync(join(root, path)).isSymbolicLink())
      throw new Error(`Workspace must not be a symlink: ${path}`)
    const manifest = readJson(join(root, path, 'package.json'))
    if (typeof manifest.name !== 'string' || names.has(manifest.name))
      throw new Error(`Invalid or duplicate workspace name at ${path}`)
    names.add(manifest.name)
    if (
      !supportWorkspaces.includes(path) &&
      (!manifest.name.startsWith('@superdsh/') || manifest.private !== true)
    )
      throw new Error(
        `Owned workspace must be a private @superdsh package: ${path}`,
      )
    return { path, manifest }
  })
}

export function verifyDependencyBoundaries(workspace, packages) {
  const owned = new Set(
    packages
      .filter((row) => !supportWorkspaces.includes(row.path))
      .map((row) => row.manifest.name),
  )
  for (const { path, manifest } of [
    { path: 'root', manifest: workspace },
    ...packages,
  ]) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'resolutions',
    ]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range !== 'string')
          throw new Error(`${path} ${field}.${name} must be a string`)
        if (range.startsWith('workspace:')) {
          if (
            !name.startsWith('@superdsh/') ||
            !owned.has(name) ||
            field === 'resolutions'
          )
            throw new Error(
              `${path} ${field}.${name} bypasses the owned workspace boundary`,
            )
        } else if (/^(?:portal|link):/u.test(range))
          throw new Error(
            `${path} ${field}.${name} bypasses the published runtime boundary`,
          )
        const decoded = decodeURIComponent(range).replaceAll('\\', '/')
        if (/(?:^|[/#:])deepseek-harness(?:[/#]|$)/u.test(decoded))
          throw new Error(
            `${path} ${field}.${name} bypasses the Harness vendor boundary`,
          )
        if (
          isDshPackage(name) &&
          /(?:file|patch|git|https?):/u.test(decoded) &&
          !/(?:^|@)file:(?:\.\.\/)*vendor\/dsh-runtime\//u.test(decoded)
        ) {
          throw new Error(
            `${path} ${field}.${name} must resolve through the recorded Harness vendor`,
          )
        }
      }
    }
  }
}
