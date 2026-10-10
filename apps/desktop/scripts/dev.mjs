/** Explicit interactive development: owned frontend watcher and the Electron app share a lifetime. */
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareNodeShim } from './node-shim.ts'
const root = fileURLToPath(new URL('..', import.meta.url))
prepareNodeShim(root)
const require = createRequire(join(root, 'package.json'))
const frontend = dirname(require.resolve('@superdsh/ui/package.json'))
const frontendRequire = createRequire(join(frontend, 'package.json'))
const environment = { ...process.env, SUPERDSH_WATCH: '1' }
delete environment.ELECTRON_RUN_AS_NODE
const watcher = spawn(
  process.execPath,
  [
    '--import',
    pathToFileURL(frontendRequire.resolve('tsx')).href,
    join(frontend, 'scripts/build.ts'),
    '--watch',
  ],
  { cwd: frontend, env: environment, stdio: 'inherit', windowsHide: true },
)
const desktop = spawn(require('electron'), [root], {
  cwd: root,
  env: environment,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
})
const exited = (child) =>
  new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      resolve()
    else child.once('exit', resolve)
  })
const force = (child) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32')
    execFile(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { windowsHide: true },
      () => {},
    )
  else child.kill('SIGKILL')
}
let stopping
function stop(code = 0) {
  return (stopping ??= (async () => {
    process.exitCode = code
    watcher.kill('SIGTERM')
    if (desktop.connected) desktop.send({ type: 'superdsh:dev-stop' }, () => {})
    else desktop.kill('SIGTERM')
    const deadline = setTimeout(() => {
      force(watcher)
      force(desktop)
    }, 30_000)
    deadline.unref()
    await Promise.all([exited(watcher), exited(desktop)])
    clearTimeout(deadline)
  })())
}
for (const child of [watcher, desktop]) {
  child.once('error', (error) => {
    console.error(error)
    void stop(1)
  })
  child.once('exit', (code) => {
    void stop(code ?? 0)
  })
}
process.once('SIGINT', () => {
  void stop()
})
process.once('SIGTERM', () => {
  void stop()
})
