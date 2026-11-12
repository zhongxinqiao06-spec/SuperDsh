import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateBuildInfo } from './build-info.ts'
import { composeEnvironment } from './configuration.ts'
import { appRoot } from './paths.ts'
import { run } from './processes.ts'

/** 为原生调试导出同一套连接配置，并等待中间件与一次性初始化任务就绪。 */
export async function initializeDevelopment(rebuildDependencies = false) {
  await generateBuildInfo()
  const configuration = await composeEnvironment(
    'development',
    process.env.WEB_ADMIN_CONFIG_ROOT,
  )
  await writeFile(
    resolve(configuration.root, 'config/backend-environment.json'),
    `${JSON.stringify(
      {
        owner: 'superdsh-web-admin',
        mode: 'development',
        environment: {
          ...configuration.environment,
          WEB_ADMIN_BACKEND_PORT: String(
            configuration.configuration.ports.backendPort,
          ),
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const compose = [
    'compose',
    '--env-file',
    configuration.envFile,
    '-f',
    resolve(appRoot, 'deployment/compose.dependencies.yml'),
  ]
  const build = rebuildDependencies ? ['--build'] : []
  await run('docker', [
    ...compose,
    'up',
    ...build,
    '-d',
    '--wait',
    '--wait-timeout',
    '90',
    'postgres',
    'redis',
    'qdrant',
    'minio',
    'ollama',
  ])
  // 逐一转发一次性任务的退出码，模型校验或建桶失败时不报告就绪。
  for (const service of ['minio-init', 'ollama-init'])
    await run('docker', [
      ...compose,
      'up',
      ...build,
      '--no-deps',
      '--exit-code-from',
      service,
      service,
    ])
  console.log(
    `开发配置已就绪：${configuration.configPath}；可分别启动后端 uv 与前端 npm run dev`,
  )
}
