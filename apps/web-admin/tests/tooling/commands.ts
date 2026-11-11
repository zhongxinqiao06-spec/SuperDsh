import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { resolve } from 'node:path'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import type { ChildProcess } from 'node:child_process'
import { loadConfiguration } from '../../scripts/configuration.ts'
import { launch, stop } from '../../scripts/processes.ts'
import { backendRoot } from '../../scripts/paths.ts'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配命令验证端口'))
        return
      }
      server.close((error) => (error ? reject(error) : done(address.port)))
    })
  })
}

async function listening(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host })
    const finish = (value: boolean) => {
      socket.destroy()
      done(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

async function ready(
  url: string,
  child: ChildProcess,
  loggingError: () => Error | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const failure = loggingError()
    if (failure) throw failure
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`命令提前退出 ${child.exitCode ?? child.signalCode}`)
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return
    } catch {
      /* 启动阶段有限等待；最终失败保留独立命令日志。 */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`命令就绪超时 ${url}`)
}

async function verifyHttp(base: string, includesSpa: boolean): Promise<void> {
  const config = await fetch(`${base}/api/auth/config`)
  assert.equal(config.status, 200)
  const body: unknown = await config.json()
  assert.ok(body && typeof body === 'object' && 'needsBootstrap' in body)
  const missing = await fetch(`${base}/api/missing-command-verification`)
  assert.equal(missing.status, 404, '未知API不能返回SPA成功页面')
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/u)
  if (includesSpa) {
    for (const path of ['/', '/access/users']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /id="app"/u, '返回新Vue入口')
    }
  }
}

/** 真实命令验收消费调用方独立测试库；只在本轮目录写配置，不启动或删除外部容器。 */
export async function verifyCommandLifecycle(
  input: NodeJS.ProcessEnv,
): Promise<void> {
  assert.ok(
    input.WEB_ADMIN_VALIDATION_DIR && input.WEB_ADMIN_TEST_DATABASE_URL,
    '命令验收必须使用独立验证目录与测试库',
  )
  const directory = resolve(input.WEB_ADMIN_VALIDATION_DIR, 'commands')
  await mkdir(directory, { recursive: true })
  const configuration = await loadConfiguration(
    'development',
    resolve(directory, 'config-root'),
    resolve(directory, 'model-defaults.json'),
  )
  const frontedPort = await freePort(),
    backendPort = await freePort()
  await writeFile(
    configuration.configPath,
    JSON.stringify(
      {
        ...configuration.configuration,
        ports: {
          ...configuration.configuration.ports,
          frontedPort,
          backendPort,
        },
      },
      null,
      2,
    ),
  )
  const environment: NodeJS.ProcessEnv = {
    ...input,
    WEB_ADMIN_CONFIG_ROOT: configuration.root,
    WEB_ADMIN_MODEL_DEFAULTS_FILE: configuration.modelDefaultsFile,
    WEB_ADMIN_DATABASE_URL: input.WEB_ADMIN_TEST_DATABASE_URL,
    WEB_ADMIN_REDIS_URL:
      input.WEB_ADMIN_TEST_REDIS_URL ?? input.WEB_ADMIN_REDIS_URL,
    WEB_ADMIN_DATA_DIR: resolve(directory, 'runtime'),
    WEB_ADMIN_VALIDATION_DIR: directory,
    WEB_ADMIN_CONTROL_STDIN: '1',
    WEB_ADMIN_PUBLIC_ORIGIN: `http://localhost:${frontedPort}`,
    WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([
      `http://localhost:${frontedPort}`,
    ]),
  }
  const fronted = `http://localhost:${frontedPort}`,
    backend = `http://127.0.0.1:${backendPort}`
  const children: ChildProcess[] = []
  const logs: ReturnType<typeof createWriteStream>[] = []
  const completed: string[] = []
  let logFailure: Error | undefined
  const loggingError = () => logFailure
  function openLog(name: string) {
    const log = createWriteStream(resolve(directory, name))
    // 磁盘/内存不足也必须进入受控失败，不能由未处理的流错误跳过 finally。
    log.on('error', (error) => {
      logFailure ??= error
    })
    logs.push(log)
    return log
  }
  function start(command: string): ChildProcess {
    const log = openLog(`${command}.log`)
    const child = launch(process.execPath, ['scripts/web-admin.ts', command], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })
    children.push(child)
    return child
  }
  async function close(child: ChildProcess, ports: number[]): Promise<void> {
    const began = Date.now()
    await stop(child)
    assert.equal(child.exitCode, 0, '控制管道应触发正常退出')
    assert.ok(
      Date.now() - began < 15_000,
      '退出应协作完成，不等待强制结束宽限期',
    )
    for (const port of ports) {
      assert.equal(
        await listening(port, '127.0.0.1'),
        false,
        `IPv4端口${port}应关闭`,
      )
      assert.equal(await listening(port, '::1'), false, `IPv6端口${port}应关闭`)
    }
  }
  try {
    // 用户日常入口必须真实执行，包括配置加载、迁移和默认热重载。
    // 配置、端口和数据库均属本轮；不会读取用户正在使用的开发配置。
    await writeFile(
      resolve(configuration.root, 'config/backend-environment.json'),
      JSON.stringify({
        owner: 'superdsh-web-admin',
        mode: 'development',
        environment: {
          ...Object.fromEntries(
            Object.entries(environment).filter(
              ([key, value]) =>
                key.startsWith('WEB_ADMIN_') && typeof value === 'string',
            ),
          ),
          WEB_ADMIN_BACKEND_PORT: String(backendPort),
        },
      }),
      { mode: 0o600 },
    )
    const nativeLog = openLog('native-python.log')
    const native = launch('uv', ['run', 'python', 'main.py'], {
      cwd: backendRoot,
      env: environment,
      // 原生命令以终端信号退出，不接收 Node 启动器的私有控制消息。
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(native)
    native.stdout?.pipe(nativeLog, { end: false })
    native.stderr?.pipe(nativeLog, { end: false })
    await ready(`${backend}/api/health/ready`, native, loggingError)
    await verifyHttp(backend, false)
    await stop(native)
    assert.equal(await listening(backendPort, '127.0.0.1'), false)
    completed.push(
      'uv run python main.py: 独立配置/迁移/热重载启动/API/本轮进程树回收',
    )

    const dev = start('dev')
    await ready(`${backend}/api/health/ready`, dev, loggingError)
    await ready(`${fronted}/api/health/ready`, dev, loggingError)
    await verifyHttp(fronted, true)
    await close(dev, [frontedPort, backendPort])
    completed.push('dev: API/SPA/代理/协作退出/全部端口关闭')

    const api = start('backend-dev')
    await ready(`${backend}/api/health/ready`, api, loggingError)
    await verifyHttp(backend, false)
    assert.equal(await listening(frontedPort, '::1'), false)
    const ui = start('fronted-dev')
    await ready(`${fronted}/api/health/ready`, ui, loggingError)
    await verifyHttp(fronted, true)
    await close(ui, [frontedPort])
    assert.equal(
      (await fetch(`${backend}/api/health/ready`)).status,
      200,
      '关闭独立前端不关闭后端',
    )
    await close(api, [backendPort])
    completed.push('fronted-dev/backend-dev: 独立服务/代理/分别关闭')

    const production = start('start')
    const productionBase = `http://127.0.0.1:${frontedPort}`
    await ready(`${productionBase}/api/health/ready`, production, loggingError)
    await verifyHttp(productionBase, true)
    assert.equal(
      (await fetch(`${productionBase}/assets/missing-command-verification.js`))
        .status,
      404,
    )
    await close(production, [frontedPort, backendPort])
    completed.push('start: 构建产物/API/SPA/缺失资源404/协作退出')
    await writeFile(
      resolve(directory, 'results.json'),
      JSON.stringify({ completed }, null, 2),
    )
    console.log(completed.join('\n'))
  } finally {
    await Promise.all(children.map(stop))
    await Promise.allSettled(
      logs.map((log) => {
        log.end()
        return finished(log)
      }),
    )
  }
  if (logFailure) throw logFailure
}
