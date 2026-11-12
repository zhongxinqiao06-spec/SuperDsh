import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { appRoot, backendRoot, repositoryRoot } from './paths.ts'
import { generateBuildInfo } from './build-info.ts'
import { composeEnvironment, loadConfiguration } from './configuration.ts'
import { launch, run, supervise } from './processes.ts'
import { initializeDevelopment } from './development.ts'
import {
  ensurePythonEnvironment,
  exportPythonRequirements,
  pythonEnvironment,
  pythonExecutable,
} from './python-environment.ts'

const commandHelp: Record<string, string> = {
  sync: '冻结安装 Python 依赖，生成构建信息并编译固定 DSH 适配',
  prepare: '检查并修复 Python 虚拟环境、安装锁定依赖，不执行 build',
  requirements: '从现有锁文件导出完整运行、开发依赖，保留版本、平台条件与哈希',
  init: '准备共用 Python 环境、生成开发配置并启动完整开发依赖',
  'deps-up': '构建并启动独立开发依赖，配置和卷在重复启动时复用',
  'deps-down': '停止开发依赖，保留数据卷和密钥',
  dev: '迁移新库并启动 Vue 热更新与 Python API，Ctrl+C 协作关闭',
  preview: '检查并准备 Python 依赖，启动开发依赖与前后端源码',
  'fronted-dev': '单独启动 Vue 开发服务，代理到新 Python API',
  'backend-dev': '迁移新库并单独启动 Python API',
  migrate: '迁移显式配置的新数据库，拒绝接管未知旧库',
  build: '编译 Vue 与固定引擎适配，校验 Python 产物',
  start: '从已构建的 Vue 产物和 Python API 启动主机生产入口',
  check: '运行完整质量检查与隔离自测，finally 清理本轮运行数据',
  parity: '串行执行当轮选定差分并保留全量待验项；--report-only仅结构检查',
  up: '用独立生产 Compose 构建并启动，继承 BUILDX_BUILDER 选择',
  down: '停止新生产服务，保留持久卷和密钥',
  logs: '读取新生产服务日志，可附加 Compose logs 参数',
  'compose-config': '生成或复用独立配置，只检查 Compose，不打印密钥',
}

async function migrate(environment: NodeJS.ProcessEnv) {
  await run(
    pythonExecutable(),
    [
      '-m',
      'alembic',
      '-c',
      resolve(backendRoot, 'alembic.ini'),
      'upgrade',
      'head',
    ],
    { cwd: backendRoot, env: environment },
  )
}

export async function buildEngineAdapter() {
  await run(process.execPath, [
    'node_modules/tsdown/dist/run.mjs',
    '--config',
    'apps/web-admin/scripts/engine-contracts.config.ts',
  ])
  await run(
    process.execPath,
    [
      resolve(
        repositoryRoot,
        'apps/desktop/plugins/harness/node_modules/tsdown/dist/run.mjs',
      ),
    ],
    { cwd: resolve(repositoryRoot, 'apps/desktop/plugins/harness') },
  )
  await run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'apps/web-admin/engine-adapter/tsconfig.json',
    '--noEmit',
  ])
  await run(process.execPath, [
    'node_modules/tsdown/dist/run.mjs',
    '--config',
    'apps/web-admin/engine-adapter/tsdown.config.ts',
  ])
}

/** 根命令只是装配入口；生产命令不依赖测试代码或旧管理端实现。 */
export async function main(command = 'help', args: string[] = []) {
  if (
    ['help', '--help', '-h'].includes(command) ||
    args.some((arg) => ['--help', '-h'].includes(arg))
  ) {
    const selected = commandHelp[command]
    console.log(
      selected
        ? `web-admin ${command}: ${selected}`
        : Object.entries(commandHelp)
            .map(([name, description]) => `${name}: ${description}`)
            .join('\n'),
    )
    return
  }
  if (command === 'prepare') return ensurePythonEnvironment()
  if (command === 'requirements') return exportPythonRequirements()
  if (command === 'deps-up') return initializeDevelopment(true)
  if (command === 'init') {
    await ensurePythonEnvironment()
    return initializeDevelopment()
  }
  if (command === 'sync') {
    await generateBuildInfo()
    await ensurePythonEnvironment()
    await buildEngineAdapter()
    return
  }
  if (command === 'preview') {
    // 复用本地调试的依赖组，待模型和对象存储就绪后再启动宿主机应用。
    await ensurePythonEnvironment()
    await initializeDevelopment()
    // 复用源码启动与退出管理；不编译前端、引擎或应用镜像。
    return main('dev')
  }
  if (['up', 'down', 'logs', 'deps-down', 'compose-config'].includes(command)) {
    const production = !command.startsWith('deps-')
    const configuration = await composeEnvironment(
      production ? 'production' : 'development',
      process.env.WEB_ADMIN_CONFIG_ROOT,
    )
    const file = production
      ? resolve(repositoryRoot, 'compose.yml')
      : resolve(appRoot, 'deployment/compose.dependencies.yml')
    const action =
      command === 'up'
        ? ['up', '--build', '-d', '--wait', '--wait-timeout', '180']
        : command === 'logs'
          ? ['logs', '--tail', '100', ...args]
          : command === 'compose-config'
            ? ['config', '--quiet']
            : ['down']
    await run('docker', [
      'compose',
      '--env-file',
      configuration.envFile,
      '-f',
      file,
      ...action,
    ])
    console.log(`配置保存在 ${configuration.configPath}；停止服务保留卷和密钥`)
    return
  }
  if (command === 'build') {
    await ensurePythonEnvironment()
    await generateBuildInfo()
    await buildEngineAdapter()
    await run(process.execPath, [
      'node_modules/vue-tsc/bin/vue-tsc.js',
      '--project',
      'apps/web-admin/fronted/tsconfig.json',
      '--noEmit',
    ])
    await run(process.execPath, [
      'node_modules/vite/bin/vite.js',
      'build',
      '--config',
      'apps/web-admin/fronted/vite.config.ts',
    ])
    await run(
      pythonExecutable(),
      ['-m', 'compileall', '-q', 'app', 'toolkits', 'main.py'],
      {
        cwd: backendRoot,
        env: pythonEnvironment(),
      },
    )
    return
  }
  if (command === 'check' || command === 'parity') {
    await run(process.execPath, [
      'apps/web-admin/tests/tooling/check.ts',
      command,
      ...args,
    ])
    return
  }
  if (
    ['dev', 'fronted-dev', 'backend-dev', 'migrate', 'start'].includes(command)
  ) {
    if (command !== 'fronted-dev') await ensurePythonEnvironment()
    await generateBuildInfo()
    const configuration = await loadConfiguration(
      'development',
      process.env.WEB_ADMIN_CONFIG_ROOT,
    )
    const env = pythonEnvironment({
      ...configuration.environment,
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key.startsWith('WEB_ADMIN_'),
        ),
      ),
    })
    if (command === 'migrate') return migrate(env)
    const ports = configuration.configuration.ports
    if (command !== 'fronted-dev') await migrate(env)
    if (command === 'start') {
      const staticDirectory = resolve(appRoot, 'fronted/dist')
      if (!existsSync(resolve(staticDirectory, 'index.html')))
        throw new Error('缺少生产前端产物，请先运行 web-admin:build')
      const child = launch(
        pythonExecutable(),
        [
          '-m',
          'app.launcher',
          '--host',
          '127.0.0.1',
          '--port',
          String(ports.frontedPort),
        ],
        {
          env: { ...env, WEB_ADMIN_STATIC_DIR: staticDirectory },
          stdio: ['pipe', 'inherit', 'inherit'],
        },
      )
      return supervise([child])
    }
    const children = []
    if (command !== 'fronted-dev')
      children.push(
        launch(
          pythonExecutable(),
          [
            '-m',
            'app.launcher',
            '--host',
            '127.0.0.1',
            '--port',
            String(ports.backendPort),
          ],
          { env, stdio: ['pipe', 'inherit', 'inherit'] },
        ),
      )
    if (command !== 'backend-dev')
      children.push(
        launch(
          process.execPath,
          ['apps/web-admin/scripts/fronted-launcher.ts'],
          {
            env: {
              ...env,
              WEB_ADMIN_API_ORIGIN: `http://127.0.0.1:${ports.backendPort}`,
              WEB_ADMIN_FRONTED_PORT: String(ports.frontedPort),
            },
            stdio: ['pipe', 'inherit', 'inherit'],
          },
        ),
      )
    console.log(
      `初始管理员配置位于 ${configuration.configPath} 的 initialAdmin；新入口 http://localhost:${ports.frontedPort}`,
    )
    return supervise(children)
  }
  throw new Error(`未知命令：${command}`)
}
