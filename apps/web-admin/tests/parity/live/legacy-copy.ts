import { copyFile, mkdir, readFile, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { appRoot, repositoryRoot } from '../../../scripts/paths.ts'
import { verifyBaseline } from '../../tooling/baseline.mjs'

/** 基于冻结清单复制旧包，不复用原包可写缓存，依赖仅通过只读消费的联接解析。 */
export async function copyLegacy(directory: string): Promise<string> {
  await verifyBaseline()
  const source = resolve(directory, 'legacy')
  const manifest = JSON.parse(
    await readFile(
      resolve(appRoot, 'tests/fixtures/baselines/source-fingerprint.json'),
      'utf8',
    ),
  ) as { files: { path: string; sha256: string | null }[] }
  for (const file of manifest.files) {
    if (!file.sha256) continue
    const local = relative(
      resolve(repositoryRoot, 'apps/admin'),
      resolve(repositoryRoot, file.path),
    )
    if (!local || local.startsWith('..') || isAbsolute(local))
      throw new Error('冻结源码清单越出旧包边界')
    const target = resolve(source, local)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve(repositoryRoot, file.path), target)
  }
  await symlink(
    resolve(repositoryRoot, 'apps/admin/node_modules'),
    resolve(source, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return source
}
