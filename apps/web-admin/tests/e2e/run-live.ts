import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { backendRoot } from '../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'
import { launch, run, stop } from '../../scripts/processes.ts'

/** 测试独占临时端口，不复用可能含真实账号的既有服务。 */
async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配临时服务端口'))
        return
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      )
    })
  })
}

/** 只消费调用方创建的独立测试库；迁移、浏览器退出和后端关闭均为受管步骤。 */
export async function runLiveBrowser(
  input: NodeJS.ProcessEnv,
  specifications: readonly string[] = [
    'foundation-live.spec.ts',
    'foundation-shell.spec.ts',
    'device-file-preview-live.spec.ts',
    'phase-two-management-live.spec.ts',
    'phase-three-regressions.spec.ts',
    'phase-three-workspace-flows.spec.ts',
    'phase-three-resource-flows.spec.ts',
    'style-alignment.spec.ts',
    'workbench-richtext.spec.ts',
  ],
): Promise<void> {
  if (!input.WEB_ADMIN_TEST_DATABASE_URL || !input.WEB_ADMIN_VALIDATION_DIR) {
    throw new Error('真实浏览器测试必须提供独立测试库和验证目录')
  }
  const backendPort = await freePort()
  const frontedPort = await freePort()
  const base = `http://localhost:${frontedPort}`
  const apiOrigin = `http://127.0.0.1:${backendPort}`
  const output = resolve(input.WEB_ADMIN_VALIDATION_DIR, 'live-browser')
  await mkdir(output, { recursive: true })
  const environment = pythonEnvironment({
    ...input,
    WEB_ADMIN_DATABASE_URL: input.WEB_ADMIN_TEST_DATABASE_URL,
    WEB_ADMIN_REDIS_URL:
      input.WEB_ADMIN_TEST_REDIS_URL ?? input.WEB_ADMIN_REDIS_URL,
    WEB_ADMIN_VALIDATION_DIR: output,
    PYTHONPYCACHEPREFIX: resolve(output, 'pycache'),
    WEB_ADMIN_DATA_DIR: resolve(output, 'runtime'),
    WEB_ADMIN_PUBLIC_ORIGIN: base,
    WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([base]),
    WEB_ADMIN_FRONTED_PORT: String(frontedPort),
    WEB_ADMIN_API_ORIGIN: apiOrigin,
    WEB_ADMIN_E2E_BASE_URL: base,
    WEB_ADMIN_E2E_LIVE: '1',
    WEB_ADMIN_E2E_REUSE_SERVER: '0',
    WEB_ADMIN_INITIAL_ADMIN_USERNAME:
      input.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin',
    WEB_ADMIN_INITIAL_ADMIN_PASSWORD: input.WEB_ADMIN_E2E_PASSWORD,
    WEB_ADMIN_INITIAL_ADMIN_DISPLAY_NAME: '基础验收管理员',
  })
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
  const log = createWriteStream(resolve(output, 'backend.log'))
  const child = launch(
    pythonExecutable(),
    [
      '-m',
      'app.launcher',
      '--host',
      '127.0.0.1',
      '--port',
      String(backendPort),
    ],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let logError: Error | undefined
  log.on('error', (error) => {
    logError = new Error('临时后端日志写入失败', { cause: error })
    // 日志设备故障不能让管道背压卡住后端退出，也不能绕过测试资源 finally。
    child.stdout?.unpipe(log)
    child.stderr?.unpipe(log)
    child.stdout?.resume()
    child.stderr?.resume()
  })
  const logFinished = finished(log).catch(() => {})
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  let backendOutput = ''
  const collectOutput = (chunk: Buffer) => {
    backendOutput = (backendOutput + chunk.toString()).slice(-16_000)
  }
  child.stdout?.on('data', collectOutput)
  child.stderr?.on('data', collectOutput)
  let startupError: Error | undefined
  child.once('error', (error) => {
    startupError = error
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      if (logError) throw logError
      if (startupError) throw startupError
      if (child.exitCode !== null)
        throw new Error(`临时后端提前退出 ${child.exitCode}`)
      try {
        const response = await fetch(`${apiOrigin}/api/health/ready`, {
          signal: AbortSignal.timeout(1000),
        })
        ready = response.ok
      } catch {
        /* 有限等待启动就绪，保留后端日志解释最终失败。 */
      }
      if (ready) break
      await new Promise((done) => setTimeout(done, 500))
    }
    if (!ready)
      throw new Error('真实浏览器后端在30秒内未就绪，检查本轮 backend.log')
    await run(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        '--config',
        'apps/web-admin/tests/e2e/playwright.config.ts',
        ...specifications,
      ],
      { env: environment },
    )
  } catch (error) {
    // 清理会删除本轮文件，先输出有界且移除配置凭据/票据的失败诊断。
    for (const [name, value] of Object.entries(environment)) {
      if (value && /PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/u.test(name))
        backendOutput = backendOutput.replaceAll(value, '[redacted]')
    }
    backendOutput = backendOutput.replace(
      /([?&](?:ticket|token|accessToken|previewToken|previewAccessToken)=)[^&\s"]+/giu,
      '$1[redacted]',
    )
    console.error(backendOutput || '临时后端未产生启动日志')
    throw error
  } finally {
    try {
      await stop(child)
    } finally {
      log.end()
      await logFinished
    }
  }
  if (logError) throw logError
}
