import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateBuildInfo } from './build-info.ts'
import { composeEnvironment } from './configuration.ts'
import { appRoot } from './paths.ts'
import { run } from './processes.ts'

/** 一次准备开发配置与基础数据库；原生 Python 启动不再依赖 Node 调度服务。 */
export async function initializeDevelopment() {
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
  await run('docker', [
    'compose',
    '--env-file',
    configuration.envFile,
    '-f',
    resolve(appRoot, 'deployment/compose.dependencies.yml'),
    'up',
    '--no-build',
    '-d',
    '--wait',
    '--wait-timeout',
    '90',
    'postgres',
    'redis',
  ])
  console.log(
    `开发配置已就绪：${configuration.configPath}；可分别启动后端 uv 与前端 npm run dev`,
  )
}
