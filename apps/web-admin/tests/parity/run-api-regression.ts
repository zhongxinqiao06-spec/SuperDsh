import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'
import { run } from '../../scripts/processes.ts'
import { validationEnvironment } from '../tooling/validation.ts'

/** 只有显式运行此命令才创建本轮独立容器；真实开发库、密钥和 Home 不进入验证流程。 */
const requested = process.argv.slice(2)
const reportName =
  process.env.WEB_ADMIN_PARITY_REPORT_NAME || 'api-regression-summary.json'
if (!/^[a-z][a-z0-9_-]*\.json$/u.test(reportName))
  throw new Error('回归报告名称必须是安全 JSON 文件名')
const tests = requested.length
  ? requested
  : [
      'test_identity.py',
      'test_initial_admin.py',
      'test_account_management_phase_two.py',
      'test_models_agents_knowledge.py',
      'test_model_catalog_optionals.py',
      'test_catalog_verification.py',
      'test_configuration_projection.py',
      'test_configuration_persistence.py',
      'test_conversation_model_defaults.py',
      'test_runtime_model_defaults.py',
      'test_protocol_guards.py',
      'test_migration_and_static.py',
    ]
if (tests.some((name) => !/^test_[a-z0-9_]+\.py$/u.test(name)))
  throw new Error('仅允许显式 backend 测试文件名')
const context = await validationEnvironment()
const destination = resolve(
  repositoryRoot,
  '.superdsh-work/web-admin-validation/phase-three-api',
)
const report: Record<string, unknown> = {
  tests,
  kind: 'isolated-postgresql-redis-backend-regression',
  externalModelCalls: false,
  passed: false,
  cleanup: false,
}
try {
  await run(
    pythonExecutable(),
    [
      '-m',
      'pytest',
      '-c',
      resolve(backendRoot, 'pyproject.toml'),
      ...tests.map((name) =>
        resolve(repositoryRoot, 'apps/web-admin/tests/backend', name),
      ),
      '-q',
      '--tb=short',
      `--junitxml=${resolve(context.directory, 'results.xml')}`,
    ],
    {
      cwd: backendRoot,
      env: pythonEnvironment({
        ...context.environment,
        PYTHONPATH: [
          backendRoot,
          resolve(repositoryRoot, 'apps/web-admin/tests'),
        ].join(delimiter),
        PYTHONIOENCODING: 'utf-8',
      }),
    },
  )
  report.passed = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  try {
    const xml = await readFile(
      resolve(context.directory, 'results.xml'),
      'utf8',
    )
    const suite = /<testsuite\s([^>]+)>/u.exec(xml)?.[1] || ''
    report.results = Object.fromEntries(
      [
        ...suite.matchAll(/\b(tests|errors|failures|skipped|time)="([^"]+)"/gu),
      ].map((match) => [match[1], Number(match[2])]),
    )
  } catch {
    report.results = null
  }
  try {
    await context.cleanup()
    report.cleanup = true
  } finally {
    await mkdir(destination, { recursive: true })
    await writeFile(
      resolve(destination, reportName),
      JSON.stringify(report, null, 2) + '\n',
    )
  }
}
