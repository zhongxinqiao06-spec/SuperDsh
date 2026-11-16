import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { repositoryRoot } from '../../scripts/paths.ts'
import { repositoryFormatFiles } from './format-scope.ts'

test('格式范围遵循Git忽略规则，同时保留新源码、Schema和配置模板', async () => {
  const validationRoot = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation',
  )
  await mkdir(validationRoot, { recursive: true })
  const directory = await mkdtemp(resolve(validationRoot, 'format-scope-'))
  try {
    execFileSync('git', ['init', '--quiet'], {
      cwd: directory,
      windowsHide: true,
    })
    await writeFile(resolve(directory, '.gitignore'), 'private/\n')
    const visible = [
      'src/new-page.ts',
      'resources/document.schema.json',
      'config/defaults.example.json',
    ].map((name) => resolve(directory, name))
    const ignored = resolve(directory, 'private/actual-settings.json')
    for (const file of [...visible, ignored]) {
      await mkdir(resolve(file, '..'), { recursive: true })
      await writeFile(file, '{}\n')
    }
    assert.deepEqual(
      repositoryFormatFiles([...visible, ignored], directory),
      visible,
    )
  } finally {
    const child = relative(validationRoot, directory)
    assert.ok(child && !isAbsolute(child) && !child.startsWith(`..${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
})
