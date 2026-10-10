/** Exercise the real packaged Python control API in a disposable account Home. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MANAGED_CONNECTOR_PYTHON } from '../lib/main/platform-connector.js'
import { cleanupDisposableTree } from '../lib/backend/disposable-tree.js'
import { accountEnvironment } from '../lib/backend/platform-environment.js'
const home = mkdtempSync(join(tmpdir(), 'superdsh-connector-contract-'))
const harness = createRequire(
  new URL('../../plugins/harness/package.json', import.meta.url),
)
const packageFile = harness.resolve(
  '@agents-anywhere/dsh-bridge-next/package.json',
)
const payload = join(dirname(packageFile), 'lib', 'bundled-connector')
const uv = join(
  dirname(
    createRequire(packageFile).resolve(
      `@dataiku/uv-${process.platform}-${process.arch}/package.json`,
    ),
  ),
  'bin',
  process.platform === 'win32' ? 'uv.exe' : 'uv',
)
const launcher = join(home, 'launcher.py'),
  config = join(home, 'connector.json')
writeFileSync(launcher, MANAGED_CONNECTOR_PYTHON)
writeFileSync(
  config,
  JSON.stringify({
    serverUrl: 'http://127.0.0.1:9',
    connectorId: 'disposable-test',
    connectorToken: 'disposable-token',
    statePath: join(home, 'sync.json'),
  }),
)
const pythonIndex = process.argv.indexOf('--python')
const python =
  pythonIndex < 0 ? [] : ['--python', resolve(process.argv[pythonIndex + 1])]
let output = '',
  diagnostics = ''
const child = spawn(
  uv,
  [
    'run',
    '--no-project',
    ...python,
    '--with',
    payload,
    'python',
    launcher,
    config,
  ],
  {
    windowsHide: true,
    env: {
      ...accountEnvironment(process.env, home),
      DSH_HOME: home,
      AGENT_CONNECTOR_DATA_DIR: home,
      UV_PROJECT_ENVIRONMENT: join(home, 'venv'),
      UV_CACHE_DIR: join(home, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(home, 'python'),
      UV_DEFAULT_INDEX: 'https://pypi.org/simple',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    },
    stdio: 'pipe',
  },
)
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  while (output.includes('\n')) {
    const index = output.indexOf('\n'),
      line = output.slice(0, index)
    output = output.slice(index + 1)
    const frame = JSON.parse(line)
    const waiter = pending.get(frame.id)
    if (waiter) {
      pending.delete(frame.id)
      if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)))
      else waiter.resolve(frame.result)
    }
  }
})
child.stderr.on('data', (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-8000)
})
const exited = new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('close', (code) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`Connector exited ${code}: ${diagnostics}`))
    resolveExit(code)
  })
})
const rpc = (id, method) =>
  new Promise((resolveResult, reject) => {
    pending.set(id, { resolve: resolveResult, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method }) + '\n')
  })
const timeout = setTimeout(() => child.kill(), 240000)
try {
  const state = await rpc(1, 'connector.getState')
  assert.equal(state.running, false)
  await rpc(2, 'connector.stop')
  child.stdin.end()
  assert.equal(await exited, 0)
  process.stdout.write(
    'Packaged Connector control integration passed: Python imports, product provider registry, stdio state/stop and clean teardown in a temporary Home.\n',
  )
} finally {
  clearTimeout(timeout)
  child.kill()
  await exited
  cleanupDisposableTree(home)
}
