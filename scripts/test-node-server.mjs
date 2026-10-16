import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedTests = process.argv.slice(2)
if (requestedTests.some((name) => !/^[a-z0-9-]+\.test\.mjs$/.test(name)))
  throw new Error('Pass test basenames from apps/admin/server/test only')
const testFiles = requestedTests.length
  ? requestedTests.map((name) => `server/test/${name}`)
  : ['server/test/*.test.mjs']
const id = randomBytes(6).toString('hex')
const names = [
  `superdsh-node-test-pg-${id}`,
  `superdsh-node-test-redis-${id}`,
  `superdsh-node-test-qdrant-${id}`,
]
const password = randomBytes(24).toString('hex')
const label = `superdsh.node-test=${id}`
function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (result.error || result.status !== 0)
    throw new Error(`Test dependency operation failed: docker ${args[0]}`)
  return result.stdout.trim()
}
async function waitReady(name, command) {
  const deadline = Date.now() + 30_000
  do {
    const result = spawnSync('docker', ['exec', name, ...command], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 3000,
    })
    if (result.status === 0) return
    await new Promise((done) => setTimeout(done, 500))
  } while (Date.now() < deadline)
  throw new Error('Temporary test dependencies did not become ready')
}
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(AGENT_SERVER_|AGENT_CONNECTOR_|SUPERDSH_|DSH_HOME$|NODE_OPTIONS$|NEXT_OUTPUT$)/.test(
        name,
      ),
  ),
)
let child
let interrupted = false
const stop = () => {
  interrupted = true
  child?.kill('SIGINT')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    names[0],
    '--label',
    label,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=superdsh_node_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ])
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    names[1],
    '--label',
    label,
    '-p',
    '127.0.0.1::6379',
    'redis:8-alpine',
  ])
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    names[2],
    '--label',
    label,
    '-p',
    '127.0.0.1::6333',
    'qdrant/qdrant:v1.19.2',
  ])
  await Promise.all([
    waitReady(names[0], ['pg_isready', '-U', 'postgres']),
    waitReady(names[1], ['redis-cli', 'ping']),
  ])
  if (interrupted) throw new Error('Test run cancelled')
  const pgPort = docker(['port', names[0], '5432/tcp']).split(':').at(-1)
  const redisPort = docker(['port', names[1], '6379/tcp']).split(':').at(-1)
  const qdrantPort = docker(['port', names[2], '6333/tcp']).split(':').at(-1)
  const qdrantUrl = `http://127.0.0.1:${qdrantPort}`
  const deadline = Date.now() + 30000
  while (
    !(await fetch(`${qdrantUrl}/readyz`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline)
      throw new Error('Temporary Qdrant did not become ready')
    await new Promise((done) => setTimeout(done, 300))
  }
  console.log(
    'Running Node integration tests against disposable PostgreSQL, Redis and Qdrant; existing services are untouched.',
  )
  const code = await new Promise((done, reject) => {
    child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...testFiles],
      {
        cwd: resolve(root, 'apps/admin'),
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...cleanEnvironment,
          SUPERDSH_NODE_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/superdsh_node_test`,
          SUPERDSH_NODE_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
          SUPERDSH_NODE_TEST_QDRANT_URL: qdrantUrl,
          SUPERDSH_NODE_TEST_QDRANT_CONTAINER: names[2],
          SUPERDSH_NODE_REAL_HOST_TEST: '1',
          SUPERDSH_NODE_WEB_TEST: '1',
        },
      },
    )
    child.once('error', reject)
    child.once('exit', (status) => done(status ?? 1))
  })
  process.exitCode = code
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  for (const name of names) {
    const inspect = spawnSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{ index .Config.Labels "superdsh.node-test" }}',
        name,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    )
    if (inspect.status === 0 && inspect.stdout.trim() === id) {
      const result = spawnSync('docker', ['stop', '--time', '10', name], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 20_000,
      })
      if (result.status !== 0) {
        console.error(`Could not clean temporary test container ${name}`)
        process.exitCode = 1
      }
    }
  }
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
