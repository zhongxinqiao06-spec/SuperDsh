/** 在专属 PostgreSQL/Redis 和临时 Home 中运行后端用例，退出后清理所有测试数据。 */
import { spawn } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'
import { validationEnvironment } from './validation.ts'

const validation = await validationEnvironment()
try {
  const directory = resolve(repositoryRoot, 'apps/web-admin/backend')
  const python = resolve(
    directory,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  const exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(
      python,
      [
        '-m',
        'pytest',
        '-c',
        resolve(directory, 'pyproject.toml'),
        '--basetemp',
        resolve(validation.directory, 'pytest'),
        ...process.argv.slice(2),
      ],
      {
        cwd: directory,
        env: {
          ...validation.environment,
          PYTHONPATH: [
            directory,
            resolve(repositoryRoot, 'apps/web-admin/tests'),
          ].join(delimiter),
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => done(code ?? 1))
  })
  process.exitCode = exitCode
} finally {
  await validation.cleanup()
}
