import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  NativeAgentManager,
  nativeAgentEnvironment,
} from '../runtime/native-agent-manager.ts'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture(t, adapter, options = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superdsh-native-中文-'))
  const manager = new NativeAgentManager({ rootDirectory, adapter, ...options })
  t.after(async () => {
    await manager.close().catch(() => {})
    const path = resolve(rootDirectory)
    assert.equal(dirname(path), resolve(tmpdir()))
    assert.match(path, /superdsh-native-中文-/)
    await rm(path, { recursive: true, force: true })
  })
  return { manager, rootDirectory }
}

function controlledAdapter({ readiness = 'ready', readyDelay = 0 } = {}) {
  const contexts = []
  const children = []
  let stops = 0
  return {
    contexts,
    children,
    get stops() {
      return stops
    },
    async start(context) {
      contexts.push(context)
      // A real, controlled Node process checks lifetime without pretending to be a Host.
      const child = spawn(
        process.execPath,
        [
          '-e',
          `setTimeout(() => process.stdout.write('test-process-started\\n'), ${readyDelay}); setInterval(() => {}, 1000)`,
        ],
        {
          cwd: context.host.cwd,
          env: context.host.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      children.push(child)
      const ready = deferred()
      const exited = new Promise((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
        child.once('error', () => resolveExit({ code: 1, signal: null }))
      })
      child.stdout.once('data', () => {
        if (readiness !== 'pending')
          ready.resolve({
            hostReady: true,
            connectorReady: readiness === 'ready',
          })
      })
      let stopping
      return {
        ready: ready.promise,
        exited,
        stop() {
          stopping ??= (async () => {
            stops++
            child.kill()
            await exited
          })()
          return stopping
        },
      }
    },
  }
}

function assertExited(child) {
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
}

test('parallel prepare starts one real child and reuses it until explicitly stopped', async (t) => {
  const adapter = controlledAdapter()
  const { manager } = await fixture(t, adapter)
  const first = manager.prepare('user-one')
  assert.equal(manager.prepare('user-one'), first)
  assert.equal((await first).phase, 'ready')
  assert.equal((await manager.prepare('user-one')).phase, 'ready')
  assert.equal(adapter.children.length, 1)
  const firstContext = adapter.contexts[0]
  await writeFile(join(firstContext.paths.home, 'preserved.txt'), 'history')
  await manager.stop('user-one')
  assertExited(adapter.children[0])
  assert.equal((await manager.prepare('user-one')).phase, 'ready')
  assert.equal(adapter.children.length, 2)
  assert.deepEqual(adapter.contexts[1].paths, firstContext.paths)
  assert.equal(
    await readFile(join(firstContext.paths.home, 'preserved.txt'), 'utf8'),
    'history',
  )
})

test('stable user identities have separate fixed paths, commands and sanitized environments', async (t) => {
  const adapter = controlledAdapter()
  const { manager, rootDirectory } = await fixture(t, adapter)
  await Promise.all([
    manager.prepare('../outside'),
    manager.prepare('other-user'),
  ])
  const [first, second] = adapter.contexts
  assert.notEqual(first.paths.directory, second.paths.directory)
  for (const context of adapter.contexts) {
    for (const path of Object.values(context.paths)) {
      assert.ok(isAbsolute(path))
      assert.ok(!relative(rootDirectory, path).startsWith('..'))
    }
    assert.equal(context.host.executable, process.execPath)
    assert.equal(context.host.args.length, 1)
    assert.match(
      context.host.args[0],
      /apps[\\/]admin[\\/]server[\\/]runtime[\\/]host\.mjs$/,
    )
    assert.equal(context.host.cwd, context.paths.workspace)
    assert.ok(Object.isFrozen(context.paths))
    const env = nativeAgentEnvironment(context.paths, {
      PATH: 'trusted-tool-search-path',
      DATABASE_URL: 'db-secret',
      SECRET_KEY: 'master-secret',
      NODE_OPTIONS: '--require attacker.js',
      SUPERDSH_AGENT_CONNECTOR_TOKEN: 'connector-secret',
      API_KEY: 'provider-secret',
      HOME: '/original-home',
      APPDATA: '/original-appdata',
      HTTP_PROXY: 'http://secret@proxy',
    })
    assert.equal(env.PATH, 'trusted-tool-search-path')
    assert.equal(env.HOME, context.paths.home)
    assert.equal(env.DSH_HOME, context.paths.home)
    assert.equal(env.AGENT_CONNECTOR_DATA_DIR, context.paths.connector)
    assert.equal(env.TEMP, context.paths.temporary)
    for (const value of Object.values(env))
      assert.doesNotMatch(value, /secret|attacker|original/)
    assert.ok(!('NODE_OPTIONS' in env))
    assert.ok(!('APPDATA' in env))
  }
})

test('Host readiness alone cannot mark a Connector-backed Agent ready', async (t) => {
  const adapter = controlledAdapter({ readiness: 'host-only' })
  const { manager } = await fixture(t, adapter)
  const state = await manager.prepare('user')
  assert.equal(state.phase, 'unavailable')
  assert.equal(state.code, 'connector-not-ready')
  assertExited(adapter.children[0])
  assert.equal(adapter.stops, 1)
})

test('unexpected process exit changes state without automatic restart or task replay', async (t) => {
  const adapter = controlledAdapter()
  const { manager } = await fixture(t, adapter)
  await manager.prepare('user')
  const child = adapter.children[0]
  const exited = once(child, 'exit')
  child.kill()
  await exited
  await delay(0)
  assert.equal(manager.status('user').phase, 'error')
  assert.equal(manager.status('user').code, 'process-exited')
  await delay(25)
  assert.equal(adapter.children.length, 1)
  assert.equal((await manager.prepare('user')).phase, 'ready')
  assert.equal(adapter.children.length, 2)
})

test('stop during startup cancels pending readiness and leaves no child running', async (t) => {
  const adapter = controlledAdapter({ readiness: 'pending' })
  const { manager } = await fixture(t, adapter)
  const preparing = manager.prepare('user')
  while (!adapter.children.length) await delay(1)
  const stopping = manager.stop('user')
  assert.equal(manager.stop('user'), stopping)
  assert.equal((await stopping).phase, 'stopped')
  await preparing
  assertExited(adapter.children[0])
  assert.equal(adapter.contexts[0].signal.aborted, true)
  assert.equal(manager.status('user').phase, 'stopped')
})

test('startup timeout cleans up its process and allows only explicit retry', async (t) => {
  const adapter = controlledAdapter({ readiness: 'pending' })
  const { manager } = await fixture(t, adapter, { startupTimeoutMs: 35 })
  const state = await manager.prepare('user')
  assert.equal(state.phase, 'error')
  assert.equal(state.code, 'startup-failed')
  assertExited(adapter.children[0])
  await delay(40)
  assert.equal(adapter.children.length, 1)
})

test('close stops every user process, is idempotent and disallows later prepare', async (t) => {
  const adapter = controlledAdapter()
  const { manager } = await fixture(t, adapter)
  await Promise.all([manager.prepare('one'), manager.prepare('two')])
  const closing = manager.close()
  assert.equal(manager.close(), closing)
  await closing
  for (const child of adapter.children) assertExited(child)
  assert.equal(manager.status('one').phase, 'stopped')
  assert.equal(manager.status('two').phase, 'stopped')
  await assert.rejects(manager.prepare('one'), /closed/)
  assert.equal(adapter.stops, 2)
})

test('adapter failures expose fixed diagnostics rather than credential-bearing errors', async (t) => {
  let starts = 0
  const { manager } = await fixture(t, {
    async start() {
      starts++
      throw new Error('connection failed postgres://private-password@host')
    },
  })
  const state = await manager.prepare('user')
  assert.deepEqual(state, {
    userId: 'user',
    phase: 'error',
    code: 'startup-failed',
    message: 'Agent startup failed',
  })
  assert.equal(starts, 1)
  await manager.prepare('user')
  assert.equal(starts, 2)
})

test('stopping before adapter start completes passes cancellation and prevents late readiness', async (t) => {
  const starting = deferred()
  const { manager } = await fixture(t, {
    async start(context) {
      starting.resolve(context)
      await new Promise((_, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        )
      })
    },
  })
  const preparing = manager.prepare('user')
  const context = await starting.promise
  assert.equal((await manager.stop('user')).phase, 'stopped')
  await preparing
  assert.equal(context.signal.aborted, true)
})

test('failed shutdown prevents a duplicate process and reports failed close', async (t) => {
  let starts = 0
  const { manager } = await fixture(t, {
    async start() {
      starts++
      return {
        ready: Promise.resolve({ hostReady: true, connectorReady: true }),
        exited: new Promise(() => {}),
        async stop() {
          throw new Error('simulated shutdown failure')
        },
      }
    },
  })
  await manager.prepare('user')
  assert.equal((await manager.stop('user')).code, 'shutdown-failed')
  assert.equal((await manager.prepare('user')).code, 'shutdown-failed')
  assert.equal(starts, 1)
  await assert.rejects(manager.close(), /could not be stopped/)
})

test('startup deadline covers a hung adapter and retires a late real process', async (t) => {
  const gate = deferred()
  const entered = deferred()
  const processAdapter = controlledAdapter()
  let starts = 0
  const { manager } = await fixture(
    t,
    {
      async start(context) {
        starts++
        entered.resolve(context)
        await gate.promise
        return processAdapter.start(context)
      },
    },
    { startupTimeoutMs: 40 },
  )
  const preparing = manager.prepare('user')
  const context = await entered.promise
  assert.equal((await preparing).code, 'startup-failed')
  assert.equal(context.signal.aborted, true)
  await manager.prepare('user')
  assert.equal(starts, 1, 'unresolved startup must retain its ownership slot')
  await assert.rejects(manager.close(), /could not be stopped/)
  assert.equal(manager.status('user').code, 'startup-unresolved')
  gate.resolve()
  while (!processAdapter.children.length) await delay(1)
  const child = processAdapter.children[0]
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit')
  await delay(0)
  assertExited(child)
  assert.equal(manager.status('user').phase, 'stopped')
})

test('a failed stop can be retried without starting another instance', async (t) => {
  const exited = deferred()
  let stops = 0
  let starts = 0
  const { manager } = await fixture(t, {
    async start() {
      starts++
      return {
        ready: Promise.resolve({ hostReady: true, connectorReady: true }),
        exited: exited.promise,
        async stop() {
          stops++
          if (stops === 1) throw new Error('first stop failed')
          exited.resolve({ code: 0, signal: null })
        },
      }
    },
  })
  await manager.prepare('user')
  assert.equal((await manager.stop('user')).code, 'shutdown-failed')
  await manager.prepare('user')
  assert.equal(starts, 1)
  assert.equal((await manager.stop('user')).phase, 'stopped')
  assert.equal(stops, 2)
})

test('stop acknowledgement does not release ownership before the whole process tree exits', async (t) => {
  const allChildrenExited = deferred()
  let starts = 0
  const { manager } = await fixture(
    t,
    {
      async start() {
        starts++
        return {
          ready: Promise.resolve({ hostReady: true, connectorReady: true }),
          exited: allChildrenExited.promise,
          async stop() {},
        }
      },
    },
    { shutdownTimeoutMs: 30 },
  )
  await manager.prepare('user')
  assert.equal((await manager.stop('user')).code, 'shutdown-failed')
  await manager.prepare('user')
  assert.equal(starts, 1)
  allChildrenExited.resolve({ code: 0, signal: null })
  await delay(0)
  assert.equal((await manager.stop('user')).phase, 'stopped')
})

test('an owned root symlink is rejected before any process starts', async (t) => {
  const adapter = controlledAdapter()
  const { rootDirectory } = await fixture(t, adapter)
  const link = join(rootDirectory, 'alias')
  const target = join(rootDirectory, 'real')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(target))
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const manager = new NativeAgentManager({ rootDirectory: link, adapter })
  t.after(() => manager.close())
  assert.equal((await manager.prepare('user')).code, 'startup-failed')
  assert.equal(adapter.children.length, 0)
})
