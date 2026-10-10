import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  AA_PACKAGE,
  AA_PEERS,
  AA_REPOSITORY,
  AA_WORKSPACES,
  aaArtifactReference,
  aaWorkspaceTargets,
  aaConnectorResolution,
  assertPreparedAaRelease,
  runtimePeersCover,
} from './agents-anywhere-release-policy.mjs'
import {
  patchManifest,
  selectAaReleaseCommit,
  updateAaWorkspaceManifests,
} from './prepare-agents-anywhere-release.mjs'
import { prepareInstalledAaRuntime } from './prepare-agents-anywhere-runtime.mjs'

const commit = 'a'.repeat(40)
const version = '0.1.0-dev.0.desktop.caaaaaaaaaaaa.r12345678'
const artifact = `agents-anywhere-dsh-bridge-next-${version}.tgz`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aa-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), JSON.stringify(data))
  }
  const patch = (path, change) => {
    const data = JSON.parse(readFileSync(join(root, path), 'utf8'))
    change(data)
    write(path, data)
  }
  const runtimePeers = Object.fromEntries(
    AA_PEERS.map((name) => [name, '0.1.5-rc.2 || 0.1.7-alpha.2']),
  )
  write('package.json', {
    resolutions: { [AA_PACKAGE]: aaConnectorResolution(artifact) },
  })
  for (const { workspace, section } of aaWorkspaceTargets()) {
    write(`${workspace}/package.json`, {
      [section]: {
        [AA_PACKAGE]: aaArtifactReference(root, workspace, artifact),
        ...Object.fromEntries(AA_PEERS.map((name) => [name, '0.1.7-alpha.2'])),
      },
    })
    write(`${workspace}/node_modules/${AA_PACKAGE}/package.json`, {
      version,
      peerDependencies: runtimePeers,
    })
  }
  write(`vendor/agents-anywhere/${artifact}`, 'prepared AA bytes')
  write('vendor/agents-anywhere/provenance.json', {
    repository: AA_REPOSITORY,
    commit,
    artifact,
    desktopVersion: version,
    runtimePeers,
    sha256: createHash('sha256')
      .update(readFileSync(join(root, 'vendor/agents-anywhere', artifact)))
      .digest('hex'),
  })
  return { root, patch }
}

test('reuses the unchanged archive when its peers cover the SuperDsh runtime', (t) => {
  const { root } = fixture(t)
  const before = readFileSync(
    join(root, 'vendor/agents-anywhere/provenance.json'),
    'utf8',
  )
  assert.equal(assertPreparedAaRelease(root, commit).commit, commit)
  assert.equal(
    readFileSync(join(root, 'vendor/agents-anywhere/provenance.json'), 'utf8'),
    before,
  )
})

test('peer coverage rejects missing, incompatible and unsupported ranges', () => {
  const required = { runtime: '0.1.7-alpha.2' }
  assert.equal(
    runtimePeersCover({ runtime: '0.1.7-alpha.2 || 0.1.5-rc.2' }, required),
    true,
  )
  assert.equal(
    runtimePeersCover(
      { runtime: '0.1.7-alpha.2' },
      { runtime: '0.1.5-rc.2 || 0.1.7-alpha.2' },
    ),
    false,
  )
  assert.equal(runtimePeersCover({}, required), false)
  assert.equal(
    runtimePeersCover({ runtime: '^0.1.7-alpha.2' }, required),
    false,
  )
  assert.equal(
    runtimePeersCover({ runtime: '0.1.7-alpha.2 ||' }, required),
    false,
  )
  assert.equal(runtimePeersCover({ runtime: '0.1.7-alpha.3' }, required), false)
})

test('rejects a compatibility patch pinned to a previous AA artifact', (t) => {
  const { root, patch } = fixture(t)
  patch('package.json', (data) => {
    data.resolutions[AA_PACKAGE] = aaConnectorResolution('old.tgz')
  })
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /compatibility patch references a different AA artifact/,
  )
})

test('pins the AA staging type graph independently of the Desktop runtime peer range', (t) => {
  const { root } = fixture(t)
  const packagePath = join(root, 'staged')
  mkdirSync(packagePath)
  writeFileSync(
    join(packagePath, 'package.json'),
    JSON.stringify({
      version: '0.1.0-dev.0',
      scripts: { prepack: 'build', build: 'tsdown' },
      peerDependencies: { react: '^18' },
      devDependencies: {
        '@deepseek-ai/dsh-session': '0.1.5-rc.2',
        '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.2',
        '@deepseek-ai/schemastery': '3.18.2',
      },
      resolutions: { react: '18.3.1' },
    }),
  )
  const peers = { '@deepseek-ai/dsh-session': '0.1.7-alpha.2' }
  assert.deepEqual(patchManifest(packagePath, peers, version), {
    sourceVersion: '0.1.0-dev.0',
  })
  const staged = JSON.parse(
    readFileSync(join(packagePath, 'package.json'), 'utf8'),
  )
  assert.equal(staged.version, version)
  assert.equal(staged.scripts.prepack, undefined)
  assert.equal(
    staged.peerDependencies['@deepseek-ai/dsh-session'],
    peers['@deepseek-ai/dsh-session'],
  )
  assert.equal(staged.resolutions['@deepseek-ai/dsh-session'], '0.1.5-rc.2')
  assert.equal(
    staged.resolutions['@deepseek-ai/dsh-session-format'],
    '0.1.5-rc.2',
  )
  assert.equal(
    staged.resolutions['@deepseek-ai/dsh-typert-protocol'],
    '0.1.5-rc.2',
  )
  assert.equal(staged.resolutions['@deepseek-ai/schemastery'], '3.18.2')
  assert.equal(staged.resolutions['@deepseek-ai/cosmokit'], '1.8.3')
  assert.equal(staged.resolutions.react, '18.3.1')
})

test('rejects the Harness runtime manifest pointing at a different tarball', (t) => {
  const { root, patch } = fixture(t)
  patch('apps/desktop/plugins/harness/package.json', (data) => {
    data.dependencies[AA_PACKAGE] = 'file:../vendor/agents-anywhere/old.tgz'
  })
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /apps\/desktop\/plugins\/harness references a different AA artifact/,
  )
})

test('rejects the shell build dependency left on the old AA artifact', (t) => {
  const { root, patch } = fixture(t)
  patch('apps/desktop/package.json', (data) => {
    data.devDependencies[AA_PACKAGE] =
      'file:../../vendor/agents-anywhere/old.tgz'
  })
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /apps\/desktop references a different AA artifact/,
  )
})

test('rejects a prepared artifact after AA main advances', (t) => {
  const { root } = fixture(t)
  assert.throws(
    () => assertPreparedAaRelease(root, 'b'.repeat(40)),
    /does not match the selected AA commit/,
  )
})

test('rejects stale installed code despite updated manifests and provenance', (t) => {
  const { root, patch } = fixture(t)
  patch(
    `apps/desktop/plugins/harness/node_modules/${AA_PACKAGE}/package.json`,
    (data) => {
      data.version = '0.1.0-old'
    },
  )
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /outdated installed AA package/,
  )
})

test('requires rebuilding the AA peer patch after a Desktop runtime update', (t) => {
  const { root, patch } = fixture(t)
  patch('apps/desktop/plugins/harness/package.json', (data) => {
    data.dependencies[AA_PEERS[0]] = '0.1.7-alpha.3'
  })
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /runtime peers do not cover/,
  )
})

test('rejects installed peer metadata that no longer matches the archived provenance', (t) => {
  const { root, patch } = fixture(t)
  patch(
    `apps/desktop/plugins/harness/node_modules/${AA_PACKAGE}/package.json`,
    (data) => {
      data.peerDependencies[AA_PEERS[0]] = '0.1.7-alpha.2'
    },
  )
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /mismatched installed AA peers/,
  )
})

test('rejects corrupted or replaced vendor bytes', (t) => {
  const { root } = fixture(t)
  writeFileSync(
    join(root, 'vendor/agents-anywhere', artifact),
    'replaced bytes',
  )
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /checksum mismatch/,
  )
})

test('updates product dependencies with workspace-relative archives', (t) => {
  const { root } = fixture(t)
  updateAaWorkspaceManifests(root, 'new.tgz')
  const manifest = (workspace) =>
    JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'))
  assert.equal(
    manifest('apps/desktop/plugins/harness').dependencies[AA_PACKAGE],
    'file:../../../../vendor/agents-anywhere/new.tgz',
  )
  assert.equal(
    manifest('apps/desktop').devDependencies[AA_PACKAGE],
    'file:../../vendor/agents-anywhere/new.tgz',
  )
  assert.equal(manifest('apps/desktop').dependencies?.[AA_PACKAGE], undefined)
  assert.deepEqual(AA_WORKSPACES, [
    'apps/desktop/plugins/harness',
    'apps/desktop',
  ])
})

test('does not partially update manifests when a selected dependency is missing or duplicated', (t) => {
  const { root, patch } = fixture(t)
  const first = readFileSync(
    join(root, 'apps/desktop/plugins/harness/package.json'),
    'utf8',
  )
  patch('apps/desktop/package.json', (data) => {
    delete data.devDependencies[AA_PACKAGE]
  })
  assert.throws(
    () => updateAaWorkspaceManifests(root, 'new.tgz'),
    /missing devDependencies/,
  )
  assert.equal(
    readFileSync(
      join(root, 'apps/desktop/plugins/harness/package.json'),
      'utf8',
    ),
    first,
  )
  patch('apps/desktop/package.json', (data) => {
    data.devDependencies[AA_PACKAGE] = aaArtifactReference(
      root,
      'apps/desktop',
      artifact,
    )
    data.dependencies = { [AA_PACKAGE]: data.devDependencies[AA_PACKAGE] }
  })
  assert.throws(
    () => updateAaWorkspaceManifests(root, 'new.tgz'),
    /unexpected dependencies/,
  )
  assert.throws(
    () => assertPreparedAaRelease(root, commit),
    /unexpected dependencies/,
  )
  assert.equal(
    readFileSync(
      join(root, 'apps/desktop/plugins/harness/package.json'),
      'utf8',
    ),
    first,
  )
})

test('local check stays offline and accepts the recorded custom branch without relabeling it', () => {
  const provenance = { commit, branch: 'codex/custom-bridge' }
  const selected = selectAaReleaseCommit({
    check: true,
    verifyRelease: false,
    repository: AA_REPOSITORY,
    ref: 'main',
    provenance,
    resolveCommit() {
      throw new Error('must not contact remote during --check')
    },
  })
  assert.equal(selected, commit)
  assert.equal(provenance.branch, 'codex/custom-bridge')
})

test('release verification always resolves official main even when combined with --check', () => {
  let calls = 0
  const options = {
    check: true,
    verifyRelease: true,
    repository: AA_REPOSITORY,
    ref: 'main',
    provenance: { commit },
    resolveCommit() {
      calls++
      return 'b'.repeat(40)
    },
  }
  assert.equal(selectAaReleaseCommit(options), 'b'.repeat(40))
  assert.equal(calls, 1)
  assert.throws(
    () => selectAaReleaseCommit({ ...options, ref: 'custom-bridge' }),
    /official AA repository and main/,
  )
  assert.throws(
    () =>
      selectAaReleaseCommit({
        ...options,
        repository: 'https://example.test/fork.git',
      }),
    /official AA repository and main/,
  )
  assert.equal(calls, 1)
})

test(
  'repairs the 0644 uv payload for both Mac architectures in the owned workspaces',
  { skip: process.platform === 'win32' },
  (t) => {
    const { root } = fixture(t)
    const files = AA_WORKSPACES.flatMap((workspace) =>
      ['arm64', 'x64'].map((arch) =>
        join(
          root,
          workspace,
          'node_modules',
          '@dataiku',
          `uv-darwin-${arch}`,
          'bin',
          'uv',
        ),
      ),
    )
    for (const path of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'uv fixture')
      chmodSync(path, 0o644)
    }
    prepareInstalledAaRuntime(root, 'darwin')
    for (const path of files) {
      assert.equal(statSync(path).mode & 0o777, 0o755)
      assert.doesNotThrow(() => accessSync(path, constants.X_OK))
      assert.equal(readFileSync(path, 'utf8'), 'uv fixture')
    }
  },
)
