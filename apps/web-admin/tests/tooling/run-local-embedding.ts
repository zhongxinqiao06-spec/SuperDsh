import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { validationEnvironment } from './validation.ts'
import { repositoryRoot } from '../../scripts/paths.ts'

/** 手动运行真实本地模型验证，缓存、下载与临时依赖随本轮 finally 清理。 */
const validation = await validationEnvironment()
try {
  const directory = resolve(repositoryRoot, 'apps/web-admin/backend')
  const python = resolve(
    directory,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  process.exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(
      python,
      [
        resolve(
          repositoryRoot,
          'apps/web-admin/tests/tooling/verify-local-embedding.py',
        ),
      ],
      {
        cwd: directory,
        env: {
          ...validation.environment,
          PYTHONPATH: directory,
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => done(code ?? 1))
  })
} finally {
  await validation.cleanup()
}
