import { writeFile } from 'node:fs/promises'
import { resolve, delimiter } from 'node:path'
import { buildEngineAdapter } from '../../scripts/cli.ts'
import { backendRoot, appRoot } from '../../scripts/paths.ts'
import {
  ensurePythonEnvironment,
  pythonEnvironment,
} from '../../scripts/python-environment.ts'
import { runLiveBrowser } from '../e2e/run-live.ts'
import { validationEnvironment } from './validation.ts'
import { startOfficeModel } from '../fixtures/office-model.ts'

/** 在独立数据库、受控模型及临时运行目录中验证完整交付链，退出时清理包括引擎 Home 在内的全部数据。 */
await ensurePythonEnvironment()
await buildEngineAdapter()
const context = await validationEnvironment()
try {
  const model = await startOfficeModel()
  try {
    const configFile = resolve(context.directory, 'model-defaults.json')
    await writeFile(
      configFile,
      JSON.stringify({
        connections: [
          {
            id: 'office-test',
            name: '本地办公验收',
            baseUrl: model.origin,
            adapter: 'openai-completions',
            apiKey: 'synthetic-office-fixture',
          },
        ],
        configurations: [
          {
            id: 'office-chat',
            name: '办公验收模型',
            connectionId: 'office-test',
            modelId: 'office-workflow',
            capability: 'chat',
          },
        ],
        defaults: { chat: 'office-chat' },
      }),
    )
    await runLiveBrowser(
      pythonEnvironment({
        ...context.environment,
        WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS: model.origin,
        WEB_ADMIN_OFFICE_DELIVERY_LIVE: '1',
        WEB_ADMIN_E2E_PASSWORD:
          'Synthetic-' + context.directory.split(/[\\/]/).at(-1) + '!',
        PYTHONPATH: [backendRoot, resolve(appRoot, 'tests')].join(delimiter),
      }),
      ['office-delivery-live.spec.ts'],
    )
  } finally {
    await model.close()
  }
} finally {
  await context.cleanup()
}
