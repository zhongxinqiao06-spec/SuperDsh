import { randomBytes } from 'node:crypto'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { appRoot, backendRoot } from '../../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../../scripts/python-environment.ts'
import { launch, run, stop } from '../../../scripts/processes.ts'
import { validationEnvironment } from '../../tooling/validation.ts'
import { copyLegacy } from './legacy-copy.ts'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return reject(new Error('没有临时端口'))
      server.close((error) => (error ? reject(error) : done(address.port)))
    })
  })
}

/** 双服务只使用本轮数据库、账号、Redis分库和Home，禁止读取宿主的模型密钥。 */
export async function twinEnvironment() {
  const context = await validationEnvironment()
  const children: ChildProcess[] = []
  const logs: ReturnType<typeof createWriteStream>[] = []
  const cleanup = async () => {
    for (const child of children.reverse()) await stop(child)
    for (const log of logs) await new Promise<void>((done) => log.end(done))
    await context.cleanup()
  }
  try {
    const source = await copyLegacy(context.directory)
    const ownership = JSON.parse(
      await readFile(resolve(context.directory, 'ownership.json'), 'utf8'),
    ) as { containerNames: string[] }
    const postgres = ownership.containerNames.find((name) =>
      name.endsWith('-pg'),
    )!
    const oldPassword = randomBytes(24).toString('hex')
    for (const sql of [
      `CREATE ROLE legacy_parity LOGIN PASSWORD '${oldPassword}'`,
      'CREATE DATABASE legacy_parity OWNER legacy_parity',
    ])
      execFileSync(
        'docker',
        [
          'exec',
          postgres,
          'psql',
          '-U',
          'web_admin_test',
          '-d',
          'web_admin_test',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          sql,
        ],
        { windowsHide: true, stdio: 'pipe' },
      )
    const oldDatabase = new URL(
      context.environment.WEB_ADMIN_DATABASE_URL!.replace(
        'postgresql+asyncpg:',
        'postgresql:',
      ),
    )
    oldDatabase.username = 'legacy_parity'
    oldDatabase.password = oldPassword
    oldDatabase.pathname = '/legacy_parity'
    const oldRedis = new URL(context.environment.WEB_ADMIN_REDIS_URL!)
    oldRedis.pathname = '/1'
    const cleared = Object.fromEntries(
      Object.keys(process.env)
        .filter((name) =>
          /^(?:WEB_ADMIN_|SUPERDSH_|DSH_|AGENT_SERVER_)/u.test(name),
        )
        .map((name) => [name, undefined]),
    )
    const settings = Object.fromEntries(
      Object.entries(context.environment).filter(([name]) =>
        /^(?:WEB_ADMIN_(?:TEST_DATABASE_URL|TEST_REDIS_URL|DATABASE_URL|REDIS_URL|SECRET|ENCRYPTION_KEY|SETUP_TOKEN|SETUP_TOKEN_EXPIRES_AT|INITIAL_ADMIN_USERNAME|INITIAL_ADMIN_PASSWORD|INITIAL_ADMIN_DISPLAY_NAME|DATA_DIR|VALIDATION_DIR)|PYTHONPYCACHEPREFIX)$/u.test(
          name,
        ),
      ),
    )
    const port = await freePort()
    const canonicalBase = `http://127.0.0.1:${port}`
    const environment: NodeJS.ProcessEnv = pythonEnvironment({
      ...cleared,
      ...settings,
      WEB_ADMIN_PUBLIC_ORIGIN: canonicalBase,
      WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([canonicalBase]),
      WEB_ADMIN_QDRANT_URL: 'http://127.0.0.1:1',
      WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS: '',
      WEB_ADMIN_EMBEDDING_TRUSTED_ORIGINS: '',
      PYTHONPATH: backendRoot,
      PYTHONDONTWRITEBYTECODE: '1',
      NODE_OPTIONS: '--max-old-space-size=512',
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
    const attach = (child: ChildProcess, filename: string) => {
      children.push(child)
      const log = createWriteStream(resolve(context.directory, filename))
      logs.push(log)
      child.stdout?.pipe(log, { end: false })
      child.stderr?.pipe(log, { end: false })
      return child
    }
    const legacy = attach(
      launch(
        process.execPath,
        [resolve(appRoot, 'tests/parity/live/legacy-server.ts')],
        { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      'legacy.log',
    )
    const ready = new Promise<number>((done, reject) => {
      let buffered = ''
      const timer = setTimeout(
        () => reject(new Error('旧隔离平台启动超时')),
        90_000,
      )
      const onData = (chunk: Buffer) => {
        buffered = (buffered + chunk.toString()).slice(-2000)
        const match = buffered.match(/@@parity-ready@@(\d+)/u)
        if (match) {
          clearTimeout(timer)
          done(Number(match[1]))
          legacy.stdout?.off('data', onData)
        }
      }
      legacy.stdout?.on('data', onData)
      legacy.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      legacy.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`旧隔离平台退出 ${code}`))
      })
    })
    const oldHome = resolve(context.directory, 'legacy-runtime')
    await mkdir(oldHome, { recursive: true })
    legacy.stdin!.write(
      JSON.stringify({
        source,
        configuration: {
          databaseUrl: oldDatabase.href,
          redisUrl: oldRedis.href,
          secret: randomBytes(48).toString('hex'),
          encryptionKey: randomBytes(32).toString('base64url'),
          dataDirectory: oldHome,
          filesDirectory: resolve(oldHome, 'files'),
          hostname: '127.0.0.1',
          port: 0,
          apiPort: 0,
          origins: [],
          setupToken: environment.WEB_ADMIN_SETUP_TOKEN,
          qdrantUrl: 'http://127.0.0.1:1',
          dev: true,
        },
      }) + '\n',
    )
    const legacyPort = await ready
    const current = attach(
      launch(
        pythonExecutable(),
        ['-m', 'app.launcher', '--host', '127.0.0.1', '--port', String(port)],
        { cwd: backendRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      'current.log',
    )
    let currentReady = false
    for (let attempt = 0; attempt < 90; attempt++) {
      if (current.exitCode !== null)
        throw new Error(`新隔离平台提前退出 ${current.exitCode}`)
      try {
        currentReady = (
          await fetch(`${canonicalBase}/api/health/ready`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      } catch {
        /* 启动只做有界等待。 */
      }
      if (currentReady) break
      await delay(500)
    }
    if (!currentReady) throw new Error('新隔离平台就绪超时')
    return {
      directory: context.directory,
      legacyBase: `http://127.0.0.1:${legacyPort}`,
      canonicalBase,
      setupToken: environment.WEB_ADMIN_SETUP_TOKEN!,
      cleanup,
    }
  } catch (error) {
    // 失败前保留有界启动诊断；凭据均为本轮随机合成，仍主动脱敏。
    for (const filename of ['legacy.log', 'current.log']) {
      const output = await readFile(
        resolve(context.directory, filename),
        'utf8',
      ).catch(() => '')
      console.error(
        output
          .slice(-6000)
          .replace(/postgresql(?:\+asyncpg)?:\/\/[^\s]+/gu, '[database]'),
      )
    }
    await cleanup()
    throw error
  }
}
