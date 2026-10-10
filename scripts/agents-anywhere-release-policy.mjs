/** Validate the AA artifact selected by SuperDsh, with explicit legacy coverage. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export const AA_REPOSITORY =
  'https://github.com/anywhere-labs/Agents-Anywhere.git'
export const AA_PACKAGE = '@agents-anywhere/dsh-bridge-next'
export const AA_WORKSPACES = ['apps/desktop/plugins/harness', 'apps/desktop']
export const AA_PEERS = [
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
]

export function aaConnectorResolution(artifact) {
  return `patch:${AA_PACKAGE}@file%3Avendor/agents-anywhere/${artifact}#./patches/agents-anywhere-connector-httpx.patch`
}

export function aaWorkspaceTargets() {
  return AA_WORKSPACES.map((workspace) => ({
    workspace,
    section: workspace === 'apps/desktop' ? 'devDependencies' : 'dependencies',
  }))
}

export function aaArtifactReference(root, workspace, artifact) {
  if (
    typeof artifact !== 'string' ||
    !artifact.endsWith('.tgz') ||
    /[\\/]/u.test(artifact) ||
    basename(artifact) !== artifact
  ) {
    throw new Error('Invalid AA artifact path')
  }
  return `file:${relative(
    join(root, workspace),
    join(root, 'vendor/agents-anywhere', artifact),
  )
    .split(sep)
    .join('/')}`
}

const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

export function runtimePeerRanges(root, options = {}) {
  const manifests = aaWorkspaceTargets(options).map(
    ({ workspace, section }) =>
      json(join(root, workspace, 'package.json'))[section],
  )
  return Object.fromEntries(
    AA_PEERS.map((name) => {
      const ranges = manifests.map((dependencies) => dependencies?.[name])
      if (ranges.some((range) => typeof range !== 'string' || !range))
        throw new Error(`Missing AA runtime peer: ${name}`)
      return [name, [...new Set(ranges)].join(' || ')]
    }),
  )
}

// Release staging emits unions of exact pinned versions, never arbitrary semver
// expressions. An existing archive may support more versions than today's
// workspaces; removing a workspace must not require rewriting its provenance.
export function runtimePeersCover(artifactPeers, requiredPeers) {
  const alternatives = (range) => {
    if (typeof range !== 'string') return undefined
    const versions = range.split('||').map((version) => version.trim())
    return versions.every((version) =>
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version),
    )
      ? new Set(versions)
      : undefined
  }
  return Object.entries(requiredPeers).every(([name, range]) => {
    const available = alternatives(artifactPeers?.[name])
    const required = alternatives(range)
    return (
      available !== undefined &&
      required !== undefined &&
      [...required].every((version) => available.has(version))
    )
  })
}

/** Throws on stale provenance, an incompatible runtime, or an obsolete installation. */
export function assertPreparedAaRelease(
  root,
  expectedCommit,
  { installed = true, legacy = false } = {},
) {
  const provenance = json(join(root, 'vendor/agents-anywhere/provenance.json'))
  const fail = (message) => {
    throw new Error(
      `AA release check failed: ${message}. Run corepack yarn aa:prepare-release.`,
    )
  }
  if (
    !/^[a-f0-9]{40}$/.test(expectedCommit) ||
    provenance.commit !== expectedCommit
  )
    fail('artifact does not match the selected AA commit')
  if (provenance.repository !== AA_REPOSITORY)
    fail('unexpected source repository')
  const artifact = provenance.artifact
  if (
    typeof artifact !== 'string' ||
    /[\\/]/u.test(artifact) ||
    basename(artifact) !== artifact ||
    !artifact.endsWith('.tgz')
  )
    fail('invalid artifact path')
  if (
    json(join(root, 'package.json')).resolutions?.[AA_PACKAGE] !==
    aaConnectorResolution(artifact)
  )
    fail('Connector compatibility patch references a different AA artifact')
  if (
    !runtimePeersCover(
      provenance.runtimePeers,
      runtimePeerRanges(root, { legacy }),
    )
  )
    fail('artifact runtime peers do not cover the selected DSH runtime')
  if (
    !provenance.desktopVersion?.includes(
      `.desktop.c${expectedCommit.slice(0, 12)}.`,
    )
  )
    fail('artifact version does not identify the selected commit')
  const bytes = readFileSync(join(root, 'vendor/agents-anywhere', artifact))
  if (createHash('sha256').update(bytes).digest('hex') !== provenance.sha256)
    fail('artifact checksum mismatch')
  for (const { workspace, section } of aaWorkspaceTargets({ legacy })) {
    const manifest = json(join(root, workspace, 'package.json'))
    if (
      manifest[section]?.[AA_PACKAGE] !==
      aaArtifactReference(root, workspace, artifact)
    )
      fail(`${workspace} references a different AA artifact`)
    const otherSection =
      section === 'dependencies' ? 'devDependencies' : 'dependencies'
    if (manifest[otherSection]?.[AA_PACKAGE] !== undefined)
      fail(`${workspace} declares AA in unexpected ${otherSection}`)
    if (installed) {
      const dependency = json(
        join(root, workspace, 'node_modules', AA_PACKAGE, 'package.json'),
      )
      if (dependency.version !== provenance.desktopVersion)
        fail(`${workspace} has an outdated installed AA package`)
      for (const [name, range] of Object.entries(provenance.runtimePeers)) {
        if (dependency.peerDependencies?.[name] !== range)
          fail(`${workspace} has mismatched installed AA peers`)
      }
    }
  }
  return provenance
}
