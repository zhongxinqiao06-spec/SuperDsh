import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import { pythonEnvironment } from '../../scripts/python-environment.ts'

const workRoot = resolve(repositoryRoot, '.superdsh-work')
const toolsRoot = resolve(workRoot, 'web-admin-tools')
const keys = [
  'PYTHONPYCACHEPREFIX',
  'UV_CACHE_DIR',
  'RUFF_CACHE_DIR',
  'MYPY_CACHE_DIR',
] as const
const emptyEnvironment = Object.fromEntries(keys.map((key) => [key, undefined]))

test('Python 和工具缓存默认全部位于项目工作目录', () => {
  const environment = pythonEnvironment(emptyEnvironment)
  for (const [key, folder] of [
    ['PYTHONPYCACHEPREFIX', 'pycache'],
    ['UV_CACHE_DIR', 'uv-cache'],
    ['RUFF_CACHE_DIR', 'ruff'],
    ['MYPY_CACHE_DIR', 'mypy'],
  ] as const)
    assert.equal(environment[key], resolve(toolsRoot, folder))
})

test('验证目录内的显式缓存覆盖保持生效', () => {
  const overrides = Object.fromEntries(
    keys.map((key) => [
      key,
      resolve(workRoot, 'web-admin-validation/synthetic-cache', key),
    ]),
  )
  const environment = pythonEnvironment(overrides)
  for (const key of keys) assert.equal(environment[key], overrides[key])
})

for (const key of keys) {
  test(`${key} 拒绝源码、外部、同名前缀和空路径`, () => {
    for (const path of [
      backendRoot,
      dirname(repositoryRoot),
      `${workRoot}-outside`,
      '',
      resolve(workRoot, '../outside-cache'),
    ]) {
      assert.throws(
        () => pythonEnvironment({ ...emptyEnvironment, [key]: path }),
        new RegExp(key),
      )
    }
  })
}

test('工作目录内的联接不能把缓存重定向到后端源码', async () => {
  const validationRoot = resolve(workRoot, 'web-admin-validation')
  await mkdir(validationRoot, { recursive: true })
  const directory = await mkdtemp(resolve(validationRoot, 'cache-boundary-'))
  try {
    const link = resolve(directory, 'source-link')
    await symlink(
      backendRoot,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    assert.throws(
      () =>
        pythonEnvironment({
          ...emptyEnvironment,
          PYTHONPYCACHEPREFIX: resolve(link, 'cache'),
        }),
      /PYTHONPYCACHEPREFIX/,
    )
  } finally {
    const child = relative(validationRoot, directory)
    assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
})
