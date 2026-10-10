import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  developmentComposeArgs,
  developmentEnvFile,
  developmentEnvironment,
  prepareDevelopmentEnv,
  prepareDevelopmentAgentEnv,
  verifyDevelopmentDatabaseContainer,
} from './server-development.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = join(repositoryRoot, 'apps/server')
const action = process.argv[2]
const extraArgs = process.argv.slice(3)
const uv = resolveUv()

function resolveUv() {
  if (process.env.UV_PATH) return process.env.UV_PATH
  try {
    const require = createRequire(
      join(repositoryRoot, 'apps/desktop/plugins/harness/package.json'),
    )
    const packageFile = require.resolve('@dataiku/uv/package.json')
    const platformFile = createRequire(packageFile).resolve(
      `@dataiku/uv-${process.platform}-${process.arch}/package.json`,
    )
    return join(
      dirname(platformFile),
      'bin',
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    )
  } catch {
    return 'uv'
  }
}

// Tests must never inherit a real database or login from the caller's shell.
function testEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !name.startsWith('AGENT_SERVER_') &&
          !name.startsWith('AGENT_CONNECTOR_') &&
          !name.startsWith('SUPERDSH_AGENT_') &&
          name !== 'SUPERDSH_BOOTSTRAP_DEV_ADMIN' &&
          name !== 'SUPERDSH_MODEL_ENCRYPTION_KEY',
      ),
    ),
    PYTHONUTF8: '1',
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: serverRoot,
      stdio: 'inherit',
      env: { ...process.env, PYTHONUTF8: '1' },
      ...options,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveResult()
      else reject(new Error(`${command} exited with ${signal || code}`))
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

async function migrateDevelopmentDatabase(env) {
  await run(
    uv,
    [
      'run',
      '--locked',
      '--python',
      '3.12',
      'python',
      '-m',
      'agent_server.infra.db.migrations',
      'upgrade',
    ],
    { env },
  )
}

async function bootstrapDevelopmentAdmin(env) {
  if (env.SUPERDSH_BOOTSTRAP_DEV_ADMIN !== '1') return
  const inspection = spawnSync(
    'docker',
    ['inspect', 'superdsh-dev-postgres-1'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  )
  if (inspection.error || inspection.status !== 0) {
    throw new Error(
      'Cannot verify the development PostgreSQL container; no default admin was created. Run server:deps:up first.',
    )
  }
  verifyDevelopmentDatabaseContainer(JSON.parse(inspection.stdout)[0], env)
  await run(
    uv,
    [
      'run',
      '--locked',
      '--python',
      '3.12',
      'python',
      '-m',
      'scripts.bootstrap_dev_admin',
    ],
    { env },
  )
  console.log(
    'Development admin is ready: username admin; initial password admin123 (existing accounts keep their current password).',
  )
}

async function startDevelopmentAgents(env) {
  if (env.SUPERDSH_DEV_AGENT_ENABLED !== '1') return env
  requireLinuxDocker()
  env = prepareDevelopmentAgentEnv(repositoryRoot)
  const image = env.SUPERDSH_AGENT_IMAGE || 'superdsh-agent-runtime:local'
  const installed = spawnSync('docker', ['image', 'inspect', image], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  })
  if (installed.status !== 0 || installed.error) {
    console.log('Preparing the Server Agent runtime image for the first use...')
    await buildAgentRuntime(image)
  }
  console.log(
    'Preparing development Agent services; the web and API still run on the host...',
  )
  await run(
    'docker',
    [
      ...developmentComposeArgs(
        repositoryRoot,
        developmentEnvFile(repositoryRoot),
      ),
      '--profile',
      'agents',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '90',
      'agent-api-relay',
      'agent-supervisor',
    ],
    { cwd: repositoryRoot, env },
  )
  return env
}

function composeArgs() {
  const projectName =
    process.env.SUPERDSH_SERVER_PROJECT || 'superdsh-mobile-test'
  const oldTestEnv = join(
    repositoryRoot,
    '.superdsh-work/mobile-link-test/aa-docker.env',
  )
  const defaultEnv = join(repositoryRoot, '.superdsh-work/server/aa-docker.env')
  const envFile = process.env.SUPERDSH_SERVER_ENV
    ? resolve(repositoryRoot, process.env.SUPERDSH_SERVER_ENV)
    : existsSync(oldTestEnv)
      ? oldTestEnv
      : defaultEnv
  if (!existsSync(envFile)) {
    if (process.env.SUPERDSH_SERVER_ENV) {
      throw new Error(`Server env file does not exist: ${envFile}`)
    }
    const volumes = spawnSync(
      'docker',
      [
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      },
    )
    if (volumes.error || volumes.status !== 0) {
      throw new Error(
        'Cannot check Docker data volumes; start Docker or set SUPERDSH_SERVER_ENV to the original env file before generating credentials.',
      )
    }
    if (volumes.stdout.trim()) {
      throw new Error(
        `Docker data volumes already exist for ${projectName}; set SUPERDSH_SERVER_ENV to the original env file. New credentials were not generated.`,
      )
    }
    mkdirSync(dirname(envFile), { recursive: true })
    writeFileSync(
      envFile,
      [
        `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
        `AGENT_SERVER_SECRET=${randomBytes(32).toString('hex')}`,
        'AGENT_SERVER_PUBLIC_ORIGIN=http://127.0.0.1:15174',
        'AGENT_SERVER_CORS_ORIGINS=http://127.0.0.1:15174,http://localhost:15174,http://127.0.0.1:5174',
        'AGENTS_ANYWHERE_WEB_PORT=15174',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )
  }
  // Persist separately from JWT signing; only startup/build prepares missing keys.
  if (
    ['up', 'build'].includes(action) &&
    !/^SUPERDSH_MODEL_ENCRYPTION_KEY=.+$/m.test(readFileSync(envFile, 'utf8'))
  ) {
    appendFileSync(
      envFile,
      `\nSUPERDSH_MODEL_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}=\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }
  if (
    ['up', 'build'].includes(action) &&
    !/^SUPERDSH_AGENT_SUPERVISOR_SECRET=.+$/m.test(
      readFileSync(envFile, 'utf8'),
    )
  ) {
    appendFileSync(
      envFile,
      `\nSUPERDSH_AGENT_SUPERVISOR_SECRET=${randomBytes(32).toString('base64url')}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }
  return [
    'compose',
    '--project-name',
    projectName,
    '--env-file',
    envFile,
    '--file',
    join(serverRoot, 'docker/compose.yml'),
  ]
}

async function main() {
  if (
    ['up', 'build', 'down', 'deps-up', 'deps-down'].includes(action) ||
    (action === 'test' && extraArgs[0] === '--docker') ||
    (action === 'check' && extraArgs[0] === '--agent')
  ) {
    requireLinuxDocker()
  }
  switch (action) {
    case 'sync':
      return run(uv, ['sync', '--locked', '--python', '3.12', ...extraArgs])
    case 'test':
      if (extraArgs[0] === '--docker') {
        await run(
          'docker',
          [
            'build',
            '--file',
            'apps/server/docker/Dockerfile',
            '--target',
            'test',
            '--tag',
            'superdsh-server-test:local',
            '.',
          ],
          { cwd: repositoryRoot },
        )
        return run(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            'superdsh-server-test:local',
            'uv',
            'run',
            '--no-sync',
            'pytest',
            '-q',
            ...extraArgs.slice(1),
          ],
          { cwd: repositoryRoot },
        )
      }
      return run(
        uv,
        ['run', '--locked', '--python', '3.12', 'pytest', '-q', ...extraArgs],
        {
          env: testEnvironment(),
        },
      )
    case 'check':
      if (extraArgs[0] === '--agent')
        return run(
          process.execPath,
          [
            join(serverRoot, 'scripts/verify-server-agent.mjs'),
            ...extraArgs.slice(1),
          ],
          { cwd: repositoryRoot, env: testEnvironment() },
        )
      return run(
        uv,
        [
          'run',
          '--locked',
          '--python',
          '3.12',
          'pytest',
          '-q',
          'tests/test_protocol_contracts.py',
          'tests/test_architecture_boundaries.py',
          ...extraArgs,
        ],
        { env: testEnvironment() },
      )
    case 'migrate':
    case 'dev': {
      let env = developmentEnvironment(repositoryRoot)
      await migrateDevelopmentDatabase(env)
      if (action === 'migrate') return
      await bootstrapDevelopmentAdmin(env)
      try {
        env = await startDevelopmentAgents(env)
      } catch (error) {
        env = developmentEnvironment(repositoryRoot)
        console.error(
          `Server Agent setup failed: ${error.message}. The development API will still start; fix the runtime and restart server:dev to retry.`,
        )
      }
      console.log(
        `Development API: http://127.0.0.1:${env.AGENT_SERVER_PORT || '8000'}; admin: http://127.0.0.1:5174`,
      )
      return run(
        uv,
        [
          'run',
          '--locked',
          '--python',
          '3.12',
          'uvicorn',
          'agent_server.app:create_app',
          '--factory',
          '--host',
          '127.0.0.1',
          '--port',
          env.AGENT_SERVER_PORT || '8000',
          '--reload',
          ...extraArgs,
        ],
        { env },
      )
    }
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
      const env = developmentEnvironment(repositoryRoot)
      await run(
        'docker',
        [
          ...developmentComposeArgs(repositoryRoot, file),
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '60',
          'postgres',
          'redis',
        ],
        { cwd: repositoryRoot, env },
      )
      if (env.SUPERDSH_BOOTSTRAP_DEV_ADMIN === '1') {
        await migrateDevelopmentDatabase(env)
        await bootstrapDevelopmentAdmin(env)
      } else {
        console.log(
          'An external database URL is configured; dependency startup did not migrate it or create a default admin.',
        )
      }
      console.log(
        'Development PostgreSQL and Redis are ready. Start server:dev and admin:dev in separate terminals.',
      )
      return
    }
    case 'deps-down': {
      if (extraArgs.length)
        throw new Error(
          'server:deps:down accepts no arguments and always preserves development volumes.',
        )
      const file = developmentEnvFile(repositoryRoot)
      if (!existsSync(file))
        throw new Error(
          'Development env file is missing; no containers were stopped.',
        )
      await run(
        'docker',
        [
          ...developmentComposeArgs(repositoryRoot, file),
          '--profile',
          'agents',
          'stop',
          '-t',
          '60',
          'agent-supervisor',
        ],
        { cwd: repositoryRoot, env: developmentEnvironment(repositoryRoot) },
      )
      await stopManagedAgents('superdsh-dev')
      return run(
        'docker',
        [
          ...developmentComposeArgs(repositoryRoot, file),
          '--profile',
          'agents',
          'down',
        ],
        { cwd: repositoryRoot, env: developmentEnvironment(repositoryRoot) },
      )
    }
    case 'build': {
      const args = composeArgs()
      await buildAgentRuntime()
      return run('docker', [...args, 'build', ...extraArgs], {
        cwd: repositoryRoot,
      })
    }
    case 'up': {
      const args = composeArgs()
      if (!extraArgs.includes('--no-build')) await buildAgentRuntime()
      return run(
        'docker',
        [
          ...args,
          'up',
          '-d',
          ...(extraArgs.includes('--no-build') ? [] : ['--build']),
          ...extraArgs,
        ],
        { cwd: repositoryRoot },
      )
    }
    case 'down': {
      if (
        extraArgs.some((argument) =>
          ['-v', '--volumes'].some(
            (flag) => argument === flag || argument.startsWith(`${flag}=`),
          ),
        )
      ) {
        throw new Error(
          'server:down preserves database volumes; destructive resets must be explicit Docker operations.',
        )
      }
      const args = composeArgs()
      // Stop controllers first: otherwise their reconciliation can recreate a
      // worker between the explicit stop and Compose teardown.
      await run(
        'docker',
        [...args, 'stop', '-t', '60', 'server-next', 'agent-supervisor'],
        { cwd: repositoryRoot },
      )
      await stopManagedAgents()
      return run('docker', [...args, 'down', ...extraArgs], {
        cwd: repositoryRoot,
      })
    }
    default:
      throw new Error(
        'Usage: node scripts/server.mjs <sync|dev|migrate|deps-up|deps-down|test|check|build|up|down> [arguments]',
      )
  }
}

async function buildAgentRuntime(
  image = process.env.SUPERDSH_AGENT_IMAGE || 'superdsh-agent-runtime:local',
) {
  await run(
    process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
    ['yarn', 'workspace', '@superdsh/harness', 'build'],
    { cwd: repositoryRoot, shell: process.platform === 'win32' },
  )
  await run(
    'docker',
    [
      'build',
      '--file',
      'apps/server/agent-runtime/Dockerfile',
      '--tag',
      image,
      '.',
    ],
    { cwd: repositoryRoot },
  )
}

async function stopManagedAgents(
  project = process.env.SUPERDSH_SERVER_PROJECT || 'superdsh-mobile-test',
) {
  const result = spawnSync(
    'docker',
    [
      'ps',
      '-q',
      '--filter',
      'label=com.superdsh.managed-agent=true',
      '--filter',
      `label=com.superdsh.project=${project}`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      'Cannot inspect managed Agent containers; data was not removed.',
    )
  const ids = result.stdout.split(/\s+/).filter(Boolean)
  if (ids.length)
    await run('docker', ['stop', '--time', '20', ...ids], {
      cwd: repositoryRoot,
    })
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
