import { delimiter, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { appRoot, backendRoot } from '../../scripts/paths.ts'
import { generateBuildInfo } from '../../scripts/build-info.ts'
import { buildEngineAdapter } from '../../scripts/cli.ts'
import {
  ensurePythonEnvironment,
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'
import { runLiveBrowser } from '../e2e/run-live.ts'
import { run } from '../../scripts/processes.ts'
import { verifyOwnership } from './ownership.ts'
import { verifyBaseline } from './baseline.mjs'
import { validationEnvironment } from './validation.ts'
import { verifyCommandLifecycle } from './commands.ts'
import { verifyOfficeRendering } from './office-rendering.ts'
import { runParity } from './parity.ts'
import { ownedCodeFiles } from '../../../../scripts/code-quality.mjs'
import { finishCheckRun } from './check-evidence.ts'

/** 新应用静态与集成验证；跨端和视觉差异由独立parity报告继续跟踪。 */
async function main() {
  if (process.argv[2] === 'parity') {
    process.exitCode = await runParity(process.argv.includes('--report-only'))
    return
  }
  await generateBuildInfo()
  await ensurePythonEnvironment()
  await verifyBaseline()
  await verifyOwnership()
  const formattedFiles = ownedCodeFiles().filter(
    (file: string) =>
      file.replaceAll('\\', '/').includes('/apps/web-admin/') &&
      !file
        .replaceAll('\\', '/')
        .endsWith('/backend/resources/build-info.json'),
  )
  await run(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs',
    '--check',
    ...formattedFiles,
  ])
  await run(process.execPath, [
    '--test',
    'apps/web-admin/tests/tooling/architecture.test.mjs',
    'apps/web-admin/tests/tooling/configuration.test.ts',
    'apps/web-admin/tests/tooling/processes.test.ts',
    'apps/web-admin/tests/tooling/python-environment.test.ts',
    'apps/web-admin/tests/tooling/python-cache.test.ts',
    'apps/web-admin/tests/tooling/check-evidence.test.ts',
    'apps/web-admin/tests/tooling/engine-tool-cancellation.test.ts',
    'apps/web-admin/tests/parity/live/session-metadata.test.ts',
  ])
  const lint = new ESLint()
  const results = await lint.lintFiles([
    'apps/web-admin/**/*.{ts,vue,mjs}',
    'scripts/web-admin.ts',
  ])
  const formatted = (await lint.loadFormatter('stylish')).format(results)
  if (formatted) console.log(formatted)
  if (results.some((entry) => entry.errorCount))
    throw new Error('新管理端 ESLint 检查失败')
  for (const project of ['fronted', 'engine-adapter', 'scripts', 'tests']) {
    const tool =
      project === 'fronted' || project === 'tests'
        ? 'node_modules/vue-tsc/bin/vue-tsc.js'
        : 'node_modules/typescript/bin/tsc'
    await run(process.execPath, [
      tool,
      '-p',
      `apps/web-admin/${project}/tsconfig.json`,
      '--noEmit',
    ])
  }
  const context = await validationEnvironment()
  const environment = pythonEnvironment({
    ...context.environment,
    PYTHONPATH: [backendRoot, resolve(appRoot, 'tests')].join(delimiter),
    MYPYPATH: resolve(appRoot, 'tests'),
    WEB_ADMIN_E2E_PASSWORD: `Synthetic-${context.directory.split(/[\\/]/u).at(-1)}!`,
  })
  let checksPassed = false
  let checkError: unknown
  try {
    await buildEngineAdapter()
    await run(
      pythonExecutable(),
      [
        '-m',
        'ruff',
        'format',
        '--config',
        'pyproject.toml',
        '--check',
        'app',
        'toolkits',
        'main.py',
        'migrations',
        '../deployment/bootstrap.py',
        '../tests/backend',
        '../tests/integration',
        '../tests/contracts',
        '../tests/fixtures',
        '../tests/tooling',
      ],
      { cwd: backendRoot, env: environment },
    )
    await run(
      pythonExecutable(),
      [
        '-m',
        'ruff',
        'check',
        '--config',
        'pyproject.toml',
        'app',
        'toolkits',
        'main.py',
        'migrations',
        '../deployment/bootstrap.py',
        '../tests/backend',
        '../tests/integration',
        '../tests/contracts',
        '../tests/fixtures',
        '../tests/tooling',
      ],
      { cwd: backendRoot, env: environment },
    )
    await run(
      pythonExecutable(),
      ['-m', 'mypy', '--config-file', 'pyproject.toml'],
      {
        cwd: backendRoot,
        env: environment,
      },
    )
    await run(
      pythonExecutable(),
      [resolve(appRoot, 'tests/tooling/architecture.py')],
      { env: environment },
    )
    await run(
      pythonExecutable(),
      [
        '-m',
        'pytest',
        '-c',
        'pyproject.toml',
        '../tests/backend',
        '../tests/integration',
        '../tests/contracts',
        '../tests/tooling',
        '-W',
        'error::pytest.PytestUnraisableExceptionWarning',
        '--basetemp',
        resolve(context.directory, 'pytest'),
        `--junitxml=${resolve(context.directory, 'pytest-junit.xml')}`,
        '-q',
      ],
      { cwd: backendRoot, env: environment },
    )
    await run(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'apps/web-admin/tests/fronted/vitest.config.ts',
      ],
      { env: environment },
    )
    await run(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'build',
        '--config',
        'apps/web-admin/fronted/vite.config.ts',
      ],
      { env: environment },
    )
    await verifyCommandLifecycle(environment)
    await verifyOfficeRendering(resolve(context.directory, 'office-semantic'))
    await runLiveBrowser(environment)
    checksPassed = true
    console.log(
      '静态、类型、领域测试、真实数据库、固定DSH、Office渲染和浏览器闭环检查通过；Docker 生命周期及差异验收分别记录',
    )
  } catch (error) {
    checkError = error
  } finally {
    await finishCheckRun({
      directory: context.directory,
      environment,
      checksPassed,
      checkError,
      cleanup: context.cleanup,
      verify: async () => {
        await verifyBaseline()
        await verifyOwnership()
      },
    })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '检查失败')
  process.exitCode = 1
})
