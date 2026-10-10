import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { prepareAaSource } from './prepare-aa-source.mjs'

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'superdsh-aa-source-')))
  t.after(() => {
    assert.ok(root.startsWith(`${realpathSync(tmpdir())}${sep}`))
    rmSync(root, { recursive: true, force: true })
  })
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  for (const name of [
    'web-next',
    'server',
    'android',
    'connector',
    'contracts',
  ])
    write(`agents-anywhere/${name}/source.txt`, name)
  const git = (args) =>
    execFileSync('git', ['-C', join(root, 'agents-anywhere'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git(['init'])
  git(['add', '.'])
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  ])
  write(
    'vendor/agents-anywhere/apps-source.json',
    JSON.stringify({ commit: git(['rev-parse', 'HEAD']) }),
  )
  for (const name of [
    'apps/admin/package.json',
    'apps/server/pyproject.toml',
    'apps/android/settings.gradle.kts',
  ])
    write(name, '')
  return { root, write, git }
}

test('sparse preparation physically removes migrated apps and retains a clean pinned engine', (t) => {
  const { root, git } = fixture(t)
  assert.throws(
    () => prepareAaSource(root, { checkOnly: true }),
    /not prepared/,
  )
  assert.ok(existsSync(join(root, 'agents-anywhere/android/source.txt')))
  prepareAaSource(root)
  prepareAaSource(root, { checkOnly: true })
  assert.equal(existsSync(join(root, 'agents-anywhere/android')), false)
  assert.ok(existsSync(join(root, 'agents-anywhere/connector/source.txt')))
  assert.equal(git(['status', '--porcelain']), '')
})

test('source preparation refuses tracked edits and preserves untracked data', (t) => {
  const { root, write, git } = fixture(t)
  write('agents-anywhere/android/source.txt', 'user edit')
  assert.throws(() => prepareAaSource(root), /tracked changes/)
  assert.equal(
    readFileSync(join(root, 'agents-anywhere/android/source.txt'), 'utf8'),
    'user edit',
  )
  git(['restore', 'android/source.txt'])
  write('agents-anywhere/android/local.properties', 'sdk.dir=existing')
  assert.throws(() => prepareAaSource(root), /untracked build\/cache/)
  assert.equal(
    readFileSync(
      join(root, 'agents-anywhere/android/local.properties'),
      'utf8',
    ),
    'sdk.dir=existing',
  )
})
