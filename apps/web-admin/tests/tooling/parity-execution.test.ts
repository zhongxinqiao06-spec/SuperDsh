import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { repositoryRoot } from '../../scripts/paths.ts'
import { freshEvidence, suiteCounts } from './parity-execution.ts'

test('实际JUnit不能接受零用例、skip、失败或缺失计数', () => {
  assert.equal(
    suiteCounts(
      '<testsuite tests="4" errors="0" failures="0" skipped="0" time="1.5"></testsuite>',
    ).tests,
    4,
  )
  assert.equal(
    suiteCounts('<testsuites><testcase name="actual"/></testsuites>').tests,
    1,
  )
  assert.throws(() =>
    suiteCounts(
      '<testsuites><testcase name="bad"><failure/></testcase></testsuites>',
    ),
  )
  for (const xml of [
    '',
    '<testsuite tests="0" errors="0" failures="0" skipped="0"></testsuite>',
    '<testsuite tests="2" errors="0" failures="0" skipped="1"></testsuite>',
    '<testsuite tests="2" errors="0" failures="1" skipped="0"></testsuite>',
    '<testsuite tests="2"></testsuite>',
    '<testsuites><testsuite tests="2" errors="0" failures="0" skipped="0"></testsuite><testsuite tests="1" errors="0" failures="1" skipped="0"></testsuite></testsuites>',
    '<testsuite tests="2" errors="0" failures="0" skipped="0"><testcase><failure/></testcase></testsuite>',
  ])
    assert.throws(() => suiteCounts(xml))
})

test('运行证据拒绝历史文件和目录越界', async () => {
  const root = resolve(repositoryRoot, '.superdsh-work/web-admin-validation')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(resolve(root, 'evidence-gate-'))
  try {
    const path = resolve(directory, 'fresh.json')
    const started = Date.now()
    await writeFile(path, '{}')
    assert.equal(await freshEvidence(directory, 'fresh.json', started), path)
    await assert.rejects(
      freshEvidence(directory, '../foreign.json', started),
      /越界/u,
    )
    const stale = new Date(started - 10000)
    await utimes(path, stale, stale)
    await assert.rejects(
      freshEvidence(directory, 'fresh.json', started),
      /本轮/u,
    )
  } finally {
    // mkdtemp由本测试生成并固定在验证根目录下，只回收本轮目录。
    assert.ok(
      directory.startsWith(root + '/') || directory.startsWith(root + '\\'),
    )
    await rm(directory, { recursive: true, force: true })
  }
})
