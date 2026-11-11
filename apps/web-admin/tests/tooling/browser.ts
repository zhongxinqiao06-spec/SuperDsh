/** 独立真实浏览器验收入口，复用完整检查的隔离依赖与生命周期管理。 */
import { delimiter, resolve } from 'node:path'
import { buildEngineAdapter } from '../../scripts/cli.ts'
import { appRoot, backendRoot } from '../../scripts/paths.ts'
import {
  ensurePythonEnvironment,
  pythonEnvironment,
} from '../../scripts/python-environment.ts'
import { runLiveBrowser } from '../e2e/run-live.ts'
import { validationEnvironment } from './validation.ts'

await ensurePythonEnvironment()
await buildEngineAdapter()
const context = await validationEnvironment()
try {
  const specifications = process.argv.slice(2)
  if (specifications.some((value) => !/^[a-z-]+\.spec\.ts$/u.test(value)))
    throw new Error('浏览器用例参数必须是 tests/e2e 下的 spec 文件名')
  await runLiveBrowser(
    pythonEnvironment({
      ...context.environment,
      PYTHONPATH: [backendRoot, resolve(appRoot, 'tests')].join(delimiter),
      WEB_ADMIN_E2E_PASSWORD: `Synthetic-${context.directory.split(/[\\/]/u).at(-1)}!`,
    }),
    specifications.length ? specifications : undefined,
  )
} finally {
  await context.cleanup()
}
