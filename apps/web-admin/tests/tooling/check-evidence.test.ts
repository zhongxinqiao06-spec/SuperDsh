import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { repositoryRoot } from '../../scripts/paths.ts'
import { finishCheckRun } from './check-evidence.ts'

const root = resolve(repositoryRoot, '.superdsh-work/web-admin-validation')

async function removeOwned(path: string): Promise<void> {
  const child = relative(root, path)
  assert.ok(
    child &&
      !isAbsolute(child) &&
      child !== '..' &&
      !child.startsWith('..' + sep),
  )
  await rm(path, { recursive: true, force: true })
}

test('归档只复制白名单并脱敏，清理测试数据后仍能读取执行报告', async () => {
  await mkdir(root, { recursive: true })
  const source = await mkdtemp(resolve(root, 'check-evidence-test-'))
  let archive = '',
    cleaned = false,
    verified = false
  try {
    for (const name of [
      'dsh-evidence.json',
      'fronted-tests.json',
      'commands/results.json',
      'live-browser/browser-results.json',
    ]) {
      const target = resolve(source, name)
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(
        target,
        JSON.stringify({
          passed: true,
          password: 'synthetic-secret',
          result: '保留业务证据',
        }),
      )
    }
    await writeFile(
      resolve(source, 'pytest-junit.xml'),
      '<testsuite tests="1"><testcase><system-out>synthetic-secret Bearer synthetic-token</system-out></testcase></testsuite>',
    )
    await mkdir(resolve(source, 'Home'))
    await writeFile(resolve(source, 'Home/config.json'), 'never-copy-this')
    await writeFile(resolve(source, 'backend.log'), 'never-copy-this')
    archive = await finishCheckRun({
      directory: source,
      environment: { WEB_ADMIN_SECRET: 'synthetic-secret' },
      checksPassed: true,
      cleanup: async () => {
        await removeOwned(source)
        cleaned = true
      },
      verify: async () => {
        verified = true
      },
    })
    assert.ok(cleaned && verified)
    const summary = JSON.parse(
      await readFile(resolve(archive, 'summary.json'), 'utf8'),
    ) as { fullCheckPassed: boolean; cleanupPassed: boolean; files: string[] }
    assert.equal(summary.fullCheckPassed, true)
    assert.equal(summary.cleanupPassed, true)
    assert.equal(summary.files.length, 5)
    assert.ok(!(await readdir(archive)).includes('Home'))
    assert.ok(!(await readdir(archive)).includes('backend.log'))
    for (const name of summary.files)
      assert.ok(
        !(await readFile(resolve(archive, name), 'utf8')).includes(
          'synthetic-secret',
        ),
      )
    assert.ok(
      (await readFile(resolve(archive, 'dsh-evidence.json'), 'utf8')).includes(
        '保留业务证据',
      ),
    )
  } finally {
    await removeOwned(source)
    if (archive) await removeOwned(archive)
  }
})

test('白名单报告无效时仍执行清理与完整性检查，并保存失败状态', async () => {
  await mkdir(root, { recursive: true })
  const source = await mkdtemp(resolve(root, 'check-evidence-test-'))
  let archive = '',
    cleaned = false,
    verified = false
  try {
    await mkdir(resolve(source, 'fronted-tests.json'))
    await assert.rejects(
      finishCheckRun({
        directory: source,
        environment: {},
        checksPassed: true,
        cleanup: async () => {
          await removeOwned(source)
          cleaned = true
        },
        verify: async () => {
          verified = true
        },
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof Error &&
            'reportDirectory' in error &&
            typeof error.reportDirectory === 'string',
        )
        archive = error.reportDirectory
        return /无效报告/u.test(error.message)
      },
    )
    assert.ok(cleaned && verified)
    const summary = JSON.parse(
      await readFile(resolve(archive, 'summary.json'), 'utf8'),
    ) as {
      fullCheckPassed: boolean
      cleanupPassed: boolean
      archivePassed: boolean
    }
    assert.equal(summary.fullCheckPassed, false)
    assert.equal(summary.cleanupPassed, true)
    assert.equal(summary.archivePassed, false)
  } finally {
    await removeOwned(source)
    if (archive) await removeOwned(archive)
  }
})
