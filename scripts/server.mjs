import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import {
  developmentComposeArgs,
  developmentEnvFile,
  developmentEnvironment,
  prepareDevelopmentEnv,
  persistDevelopmentPorts,
  verifyDevelopmentDatabaseContainer,
} from './server-development.mjs'
import {
  inspectDevelopmentContainers,
  planDevelopmentDependencies,
} from './server-dependencies.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adminRoot = join(repositoryRoot, 'apps/admin')
const coreRoot = join(repositoryRoot, 'apps/desktop/core')
const harnessRoot = join(repositoryRoot, 'apps/desktop/plugins/harness')
const action = process.argv[2]
const extraArgs = process.argv.slice(3)

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const { managedPlatform = false, ...spawnOptions } = options
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
      ...spawnOptions,
      ...(managedPlatform
        ? { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }
        : {}),
    })
    const gracefulStop = () => {
      if (child.connected) child.send({ type: 'superdsh:shutdown' })
      else if (process.platform !== 'win32') child.kill('SIGTERM')
    }
    const interrupt = () => {
      if (managedPlatform) gracefulStop()
      else if (process.platform !== 'win32') child.kill('SIGINT')
    }
    const terminate = () =>
      managedPlatform ? gracefulStop() : child.kill('SIGTERM')
    const relay = (message) => {
      if (message?.type === 'superdsh:shutdown') gracefulStop()
    }
    if (managedPlatform) {
      process.on('message', relay)
      process.on('disconnect', gracefulStop)
      child.on('message', (message) => {
        if (process.connected && message?.type === 'superdsh:ready')
          process.send(message)
      })
    }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const cleanup = () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      process.off('message', relay)
      process.off('disconnect', gracefulStop)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (code === 0 || signal === 'SIGINT') resolveResult()
      else reject(new Error(command + ' exited with ' + (signal || code)))
    })
  })
}
function requireLinuxDocker() {
  const result = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const detail = (
      result.stderr?.trim() ||
      result.error?.message ||
      `Docker 退出码：${result.status}`
    )
      .replace(/\s+/g, ' ')
      .slice(0, 500)
    throw new Error(
      '无法连接 Docker 引擎。请先启动 Docker Desktop（可执行 docker desktop start），等待 Linux 引擎就绪，再用 docker info 检查并重试。' +
        `\n原始错误：${detail}`,
    )
  }
  if (result.stdout.trim().toLowerCase() !== 'linux') {
    throw new Error(
      '当前 Docker 引擎不是 Linux。请在 Docker Desktop 切换到 Linux containers，等待引擎就绪，再用 docker info 检查并重试。',
    )
  }
}

function verifyManagedDatabase(env) {
  const containers = inspectDevelopmentContainers().filter(
    (container) =>
      container.Config?.Labels?.['com.docker.compose.service'] === 'postgres' &&
      String(
        container.Config?.Labels?.['com.docker.compose.oneoff'],
      ).toLowerCase() !== 'true',
  )
  if (containers.length !== 1)
    throw new Error(
      'Cannot identify the development PostgreSQL container; no database was changed. Run server:deps:up first.',
    )
  verifyDevelopmentDatabaseContainer(containers[0], env)
}

function productionEnvironment() {
  const file = process.env.SUPERDSH_SERVER_ENV
  if (!file)
    throw new Error(
      'Set SUPERDSH_SERVER_ENV to your native production env file. No credentials or database URLs are generated for production.',
    )
  const saved = parseEnv(readFileSync(resolve(repositoryRoot, file), 'utf8'))
  return {
    ...saved,
    ...process.env,
    NODE_ENV: 'production',
    SUPERDSH_NATIVE_PLATFORM: '1',
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: '0',
  }
}
async function buildHarness() {
  // Harness bundles public Core contracts. A clean clone has no Core lib yet.
  await run(
    process.execPath,
    [join(coreRoot, 'node_modules/tsdown/dist/run.mjs')],
    { cwd: coreRoot },
  )
  await run(
    process.execPath,
    [join(harnessRoot, 'node_modules/tsdown/dist/run.mjs')],
    { cwd: harnessRoot },
  )
}
function requireHarnessBuild() {
  if (
    !existsSync(join(harnessRoot, 'lib/host-runtime.js')) ||
    !existsSync(join(harnessRoot, 'lib/server-profile.js'))
  )
    throw new Error(
      'Harness runtime artifacts are missing. Run corepack yarn server:sync before starting the platform.',
    )
}
async function main() {
  switch (action) {
    case 'sync':
      await run(
        process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
        ['yarn', 'install', '--immutable'],
        { shell: process.platform === 'win32' },
      )
      return buildHarness()
    case 'dev':
    case 'dev-agents':
    case 'migrate': {
      if (extraArgs.length)
        throw new Error(
          'Configure ports in aa-dev.env; this command does not accept Uvicorn or Docker flags.',
        )
      const env = developmentEnvironment(repositoryRoot)
      if (env.SUPERDSH_BOOTSTRAP_DEV_ADMIN === '1') verifyManagedDatabase(env)
      if (action === 'migrate')
        return run(process.execPath, [join(adminRoot, 'server/migrate.ts')], {
          env,
        })
      requireHarnessBuild()
      return run(process.execPath, [join(adminRoot, 'server/main.ts')], {
        env: { ...env, NODE_ENV: 'development', SUPERDSH_NATIVE_PLATFORM: '1' },
        managedPlatform: true,
      })
    }
    case 'build':
      await buildHarness()
      return run(
        process.execPath,
        [join(adminRoot, 'node_modules/next/dist/bin/next'), 'build'],
        {
          cwd: adminRoot,
          env: {
            ...process.env,
            SUPERDSH_NATIVE_PLATFORM: '1',
            NEXT_OUTPUT: '',
            NODE_ENV: 'production',
          },
        },
      )
    case 'start':
    case 'up':
      if (extraArgs.length)
        throw new Error(
          'Native startup accepts no Docker options; configure SUPERDSH_SERVER_ENV instead.',
        )
      requireHarnessBuild()
      return run(process.execPath, [join(adminRoot, 'server/main.ts')], {
        env: productionEnvironment(),
        managedPlatform: true,
      })
    case 'down':
      console.log(
        'The platform runs in the foreground. Stop its terminal with Ctrl+C, or stop its configured system service. Use server:deps:down to stop only PG/Redis/Qdrant; data volumes are retained.',
      )
      return
    case 'test':
      return run(process.execPath, [
        'scripts/test-node-server.mjs',
        ...extraArgs,
      ])
    case 'check':
      await run(
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '--project',
          'server/tsconfig.json',
        ],
        { cwd: adminRoot },
      )
      await run(
        process.execPath,
        [
          '--test',
          'deployment/bootstrap.test.mjs',
          'deployment/init-config.test.mjs',
          'server/test/api-coverage.test.mjs',
          'server/test/auth-compatibility.test.mjs',
          'server/test/native-agent-manager.test.mjs',
          'server/test/platform-server.test.mjs',
          'server/test/runtime-bridge.test.mjs',
          'server/test/agent-office.test.mjs',
          'server/test/business-agent-knowledge.test.mjs',
          'server/test/business-agent-attachments.test.mjs',
        ],
        { cwd: adminRoot },
      )
      return run(process.execPath, [
        'node_modules/eslint/bin/eslint.js',
        'apps/admin/server',
      ])
    case 'deps-up': {
      if (extraArgs.length)
        throw new Error(
          'server:deps:up accepts no arguments; configure ports in aa-dev.env.',
        )
      const file = developmentEnvFile(repositoryRoot)
      if (!existsSync(file)) {
        const volumes = spawnSync(
          'docker',
          [
            'volume',
            'ls',
            '--filter',
            'label=com.docker.compose.project=superdsh-dev',
            '--format',
            '{{.Name}}',
          ],
          { encoding: 'utf8', timeout: 10000, windowsHide: true },
        )
        if (volumes.error || volumes.status !== 0)
          throw new Error(
            'Cannot inspect development volumes; no credentials were generated.',
          )
        if (volumes.stdout.trim())
          throw new Error(
            'Development volumes already exist. Restore their original aa-dev.env or set SUPERDSH_SERVER_DEV_ENV; no new credentials were generated.',
          )
      }
      prepareDevelopmentEnv(repositoryRoot)
      let env = developmentEnvironment(repositoryRoot)
      if (env.SUPERDSH_BOOTSTRAP_DEV_ADMIN !== '1') {
        console.log(
          'External database URLs are configured; skipped managed PostgreSQL/Redis/Qdrant startup and admin initialization.',
        )
        return
      }
      const plan = await planDevelopmentDependencies(
        inspectDevelopmentContainers(),
        env,
        {
          explicitEnvironment: process.env,
        },
      )
      persistDevelopmentPorts(repositoryRoot, plan.ports)
      for (const [name, value] of Object.entries(plan.ports)) {
        if (value !== env[name])
          console.log(
            `${name}: ${env[name]} -> ${value} (saved to the development env file)`,
          )
      }
      env = developmentEnvironment(repositoryRoot)
      for (const service of plan.ready)
        console.log(`${service} is already healthy; skipping startup.`)
      // Never recreate a running dependency merely to wait for its healthcheck.
      for (const [services, flags] of [
        [plan.wait, ['--no-recreate']],
        [plan.start, []],
      ]) {
        if (!services.length) continue
        await run(
          'docker',
          [
            ...developmentComposeArgs(repositoryRoot, file),
            'up',
            '-d',
            '--no-deps',
            ...flags,
            '--wait',
            '--wait-timeout',
            '60',
            ...services,
          ],
          { cwd: repositoryRoot, env },
        )
      }
      if (env.SUPERDSH_BOOTSTRAP_DEV_ADMIN === '1') {
        verifyManagedDatabase(env)
        await run(process.execPath, [join(adminRoot, 'server/migrate.ts')], {
          env,
        })
      } else {
        console.log(
          'An external database URL is configured; dependency startup did not migrate it or create a default admin.',
        )
      }
      console.log(
        `Development PostgreSQL: 127.0.0.1:${env.SUPERDSH_DEV_PG_PORT}; Redis: 127.0.0.1:${env.SUPERDSH_DEV_REDIS_PORT}; Qdrant: ${env.SUPERDSH_QDRANT_URL}. Start server:dev for the web, Node API and native Agents together.`,
      )
      return
    }

    case 'deps-down': {
      if (extraArgs.length)
        throw new Error(
          'server:deps:down accepts no arguments and preserves all volumes.',
        )
      requireLinuxDocker()
      const file = developmentEnvFile(repositoryRoot)
      if (!existsSync(file))
        throw new Error('Development env file missing; no containers stopped.')
      return run(
        'docker',
        [
          ...developmentComposeArgs(repositoryRoot, file),
          'stop',
          'postgres',
          'redis',
          'qdrant',
        ],
        { env: developmentEnvironment(repositoryRoot) },
      )
    }
    default:
      throw new Error(
        'Usage: node scripts/server.mjs <sync|dev|migrate|deps-up|deps-down|test|check|build|start>',
      )
  }
}
try {
  if (action === 'deps-up') requireLinuxDocker()
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (process.connected) process.disconnect()
}
