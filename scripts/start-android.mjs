import { execFile, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'

const root = resolve(import.meta.dirname, '..')
const configPath = join(root, '.superdsh-work', 'android-launcher.json')
const packageId = 'com.agentsanywhere.app'
const activity = `${packageId}/.MainActivity`
const execute = promisify(execFile)

function options() {
  const values = {}
  const flags = new Set(['help', 'check', 'headless'])
  const parameters = new Set([
    'sdk',
    'avd',
    'avd-home',
    'user-home',
    'apk',
    'port',
    'server',
    'gpu',
  ])
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/u, '')
    if (
      !args[index].startsWith('--') ||
      (!flags.has(key) && !parameters.has(key))
    )
      throw new Error(`Unknown argument: ${args[index]}. Use --help.`)
    if (flags.has(key)) values[key] = true
    else {
      const value = args[++index]
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for --${key}`)
      values[key] = value
    }
  }
  return values
}

async function run(file, args, env, timeout = 15_000) {
  try {
    const { stdout, stderr } = await execute(file, args, {
      env,
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    return `${stdout}${stderr}`.trim()
  } catch (error) {
    throw new Error(
      `${args[0]} failed: ${error.stderr || error.stdout || error.message}`,
      { cause: error },
    )
  }
}

async function waitFor(probe, label, timeout) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await probe()
    if (value) return value
    await delay(1000)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function requireFreePort(port) {
  const server = createServer()
  await new Promise((accept, reject) => {
    server.once('error', () =>
      reject(
        new Error(
          `Port ${port} is occupied. Use another --port; no process was stopped.`,
        ),
      ),
    )
    server.listen(port, '127.0.0.1', accept)
  })
  await new Promise((accept) => server.close(accept))
}

async function main() {
  const args = options()
  if (args.help) {
    console.log(`Usage: node scripts/start-android.mjs [options]

Starts a visible emulator, installs the existing Debug APK and opens the App.
Local settings: .superdsh-work/android-launcher.json (not committed).

--check             Check SDK, AVD and APK without booting a device
--sdk PATH          Android SDK containing platform-tools and emulator
--avd NAME          Android Virtual Device name (required if several exist)
--avd-home PATH     Directory containing AVD .ini files
--user-home PATH    Android user configuration directory
--apk PATH          APK path; default: apps/android/app/build/outputs/apk/debug/app-debug.apk
--port NUMBER       Even emulator console port, 5554..5682
--server URL        Check AA server; reverse its port for localhost URLs
                    This does not change the server saved inside the App
--gpu MODE          Emulator GPU mode (default: host)
--headless          Run without an emulator window, for automation
--help              Show this help

This launcher does not build the APK, download SDKs, clear App data or start Docker.`)
    return
  }
  const local = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {}
  const setting = (name, fallback) => args[name] ?? local[name] ?? fallback
  const defaultSdk =
    process.platform === 'win32'
      ? join(
          process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
          'Android',
          'Sdk',
        )
      : join(
          homedir(),
          process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk',
        )
  const sdk = resolve(
    root,
    setting(
      'sdk',
      process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || defaultSdk,
    ),
  )
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const adb = join(sdk, 'platform-tools', `adb${suffix}`)
  const emulator = join(sdk, 'emulator', `emulator${suffix}`)
  const apk = resolve(
    root,
    setting('apk', 'apps/android/app/build/outputs/apk/debug/app-debug.apk'),
  )
  for (const file of [adb, emulator, apk]) {
    if (!existsSync(file))
      throw new Error(
        `Missing: ${file}\nSee docs/android-local-development.md for SDK setup and APK build instructions.`,
      )
  }
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
  for (const [option, variable] of [
    ['avd-home', 'ANDROID_AVD_HOME'],
    ['user-home', 'ANDROID_USER_HOME'],
  ]) {
    const value = setting(option)
    if (value) env[variable] = resolve(root, value)
  }
  const avds = (await run(emulator, ['-list-avds'], env))
    .split(/[\r\n]+/u)
    .filter(Boolean)
  const avd = setting('avd', avds.length === 1 ? avds[0] : undefined)
  if (!avd || !avds.includes(avd))
    throw new Error(
      `Select an existing --avd. Available: ${avds.join(', ') || '(none; create one in Android Studio Device Manager)'}`,
    )
  const port = Number(setting('port', 5554))
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0)
    throw new Error('--port must be an even number between 5554 and 5682')
  const serverValue = setting('server')
  const server = serverValue ? new URL(serverValue) : undefined
  if (
    server &&
    (!['http:', 'https:'].includes(server.protocol) ||
      server.username ||
      server.password)
  )
    throw new Error('--server must be an HTTP(S) URL without credentials')
  console.log(`SDK: ${sdk}\nAVD: ${avd}\nAPK: ${apk}`)
  if (args.check) {
    console.log('Environment check passed. No emulator was started.')
    return
  }

  const serial = `emulator-${port}`
  const logDir = join(
    root,
    '.superdsh-work',
    'android-launcher',
    new Date().toISOString().replace(/[:.]/gu, '-'),
  )
  mkdirSync(logDir, { recursive: true })
  console.log(`Logs: ${logDir}`)
  const onDevice = (command, timeout) =>
    run(adb, ['-s', serial, ...command], env, timeout)
  const devices = await run(adb, ['devices'], env)
  const existing = devices
    .split(/[\r\n]+/u)
    .find((line) => line.startsWith(`${serial}\t`))
  let child
  let childFailure
  if (existing) {
    if (!existing.endsWith('\tdevice'))
      throw new Error(`${serial} is not ready: ${existing}`)
    const name = (await onDevice(['emu', 'avd', 'name']))
      .split(/[\r\n]+/u)[0]
      .trim()
    if (name !== avd)
      throw new Error(
        `${serial} belongs to ${name}, not ${avd}. Choose another --port.`,
      )
    console.log(
      `Reusing ${serial} (${avd}); its existing window mode is retained.`,
    )
  } else {
    await requireFreePort(port)
    await requireFreePort(port + 1)
    const emulatorArgs = [
      '-avd',
      avd,
      '-port',
      String(port),
      '-no-snapshot',
      '-no-boot-anim',
      '-no-audio',
      '-no-metrics',
      '-gpu',
      setting('gpu', 'host'),
      '-feature',
      '-Vulkan',
      '-memory',
      '2048',
      '-cores',
      '2',
    ]
    if (args.headless) emulatorArgs.push('-no-window')
    const stdout = openSync(join(logDir, 'emulator.stdout.log'), 'a')
    const stderr = openSync(join(logDir, 'emulator.stderr.log'), 'a')
    try {
      // The default window is intentional: this command opens an interactive emulator.
      child = spawn(emulator, emulatorArgs, {
        env,
        detached: true,
        stdio: ['ignore', stdout, stderr],
        windowsHide: false,
      })
      child.on('error', (error) => {
        childFailure = error.message
      })
      child.on('exit', (code) => {
        childFailure = `Emulator exited (${code}). Inspect ${logDir}`
      })
      child.unref()
    } finally {
      closeSync(stdout)
      closeSync(stderr)
    }
    console.log(`Booting ${serial}; waiting up to 180 seconds...`)
  }
  await waitFor(
    async () => {
      if (childFailure) throw new Error(childFailure)
      try {
        return (
          (await onDevice(['shell', 'getprop', 'sys.boot_completed'], 5000)) ===
          '1'
        )
      } catch {
        return false
      }
    },
    'Android boot',
    180_000,
  )
  const actualAvd = (await onDevice(['emu', 'avd', 'name']))
    .split(/[\r\n]+/u)[0]
    .trim()
  if (actualAvd !== avd)
    throw new Error(
      `Device identity changed: expected ${avd}, got ${actualAvd}`,
    )
  if (server) {
    if (['localhost', '127.0.0.1'].includes(server.hostname)) {
      const serverPort =
        server.port || (server.protocol === 'https:' ? '443' : '80')
      await onDevice(['reverse', `tcp:${serverPort}`, `tcp:${serverPort}`])
    }
    try {
      const response = await fetch(new URL('/api/v2/health', server), {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok || (await response.json()).status !== 'ok')
        throw new Error('health check failed')
      console.log(`AA server is healthy: ${server.origin}`)
    } catch {
      console.warn(
        `AA server is unavailable: ${server.origin}. The App can open, but sign-in/chat require the server.`,
      )
    }
  }
  console.log('Installing APK, preserving App data...')
  const install = await onDevice(['install', '-r', apk], 120_000)
  if (!/\bSuccess\b/u.test(install))
    throw new Error(`APK installation failed: ${install}`)
  const launch = await onDevice(
    ['shell', 'am', 'start', '-W', '-n', activity],
    30_000,
  )
  writeFileSync(join(logDir, 'launch.txt'), launch)
  if (!/^Status: ok\s*$/mu.test(launch))
    throw new Error(`App launch failed: ${launch}`)
  let foreground
  await waitFor(
    async () => {
      const pid = await onDevice(['shell', 'pidof', packageId]).catch(() => '')
      const state = await onDevice([
        'shell',
        'dumpsys',
        'activity',
        'activities',
      ])
      foreground = state
        .split(/\r?\n/u)
        .find(
          (line) =>
            /(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/u.test(
              line,
            ) && line.includes(activity),
        )
      return pid && foreground
    },
    'App process and foreground Activity',
    30_000,
  )
  const screenshot = join(logDir, 'started.png')
  const captured = await execute(
    adb,
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    {
      env,
      encoding: 'buffer',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  writeFileSync(screenshot, captured.stdout)
  writeFileSync(
    join(logDir, 'result.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        serial,
        avd,
        apk,
        activity,
        reusedEmulator: Boolean(existing),
        requestedHeadless: Boolean(args.headless),
        emulatorPid: child?.pid,
        foreground: foreground.trim(),
        screenshot,
        success: true,
      },
      null,
      2,
    ),
  )
  console.log(
    `Android App is running in the foreground on ${serial}.\nScreenshot: ${screenshot}\nThe emulator remains open. Close its window to exit.`,
  )
}

main().catch((error) => {
  console.error(`Android startup failed: ${error.message}`)
  process.exitCode = 1
})
