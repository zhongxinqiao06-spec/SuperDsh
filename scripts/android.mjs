import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const project = join(root, 'apps', 'android')
const configPath = join(root, '.superdsh-work', 'android-build.json')
const actions = {
  build: ['assembleDebug'],
  test: ['testDebugUnitTest'],
  check: [
    'checkLegacyRoutes',
    'checkRealtimeLifecycle',
    'checkAndroidV2ReleaseGate',
  ],
}

function parseArguments() {
  const args = process.argv.slice(2)
  const action = args.shift()
  const options = {}
  const parameters = new Set([
    'java-home',
    'sdk',
    'gradle-home',
    'init-script',
    'server',
  ])
  if (action === '--help' || !action) return { help: true }
  if (!Object.hasOwn(actions, action))
    throw new Error('Expected build, test or check. Use --help for options.')
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--help') return { help: true }
    if (argument === '--offline' || argument === '--online') {
      options.offline = argument === '--offline'
      continue
    }
    const key = argument.replace(/^--/u, '')
    if (!argument.startsWith('--') || !parameters.has(key))
      throw new Error(`Unknown argument: ${argument}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${argument}`)
    options[key] = value
  }
  return { action, options }
}

function readConfig(path) {
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
    : {}
}

async function main() {
  const { action, options, help } = parseArguments()
  if (help) {
    console.log(`Usage: node scripts/android.mjs build|test|check [options]

build  Assemble apps/android Debug APK without installing or opening a device
test   Run Android JVM unit tests without a device or emulator
check  Run the three API/realtime compatibility checks (no unit tests implied)

--java-home PATH   JDK 17; defaults to JAVA_HOME or java on PATH
--sdk PATH         Android SDK; defaults to launcher settings or ANDROID_HOME
--gradle-home PATH Reuse a Gradle dependency cache
--init-script PATH Optional machine-local Gradle repository configuration
--server URL       Debug APK default server, leaving saved App settings intact
--offline          Resolve dependencies only from the existing Gradle cache
--online           Allow Gradle to download dependencies
--help             Show this help

Machine settings: .superdsh-work/android-build.json (ignored).
Gradle owns this project; Yarn only forwards commands to this script.`)
    return
  }
  const local = readConfig(configPath)
  const launcher = readConfig(
    join(root, '.superdsh-work', 'android-launcher.json'),
  )
  const setting = (key, fallback) => options[key] ?? local[key] ?? fallback
  const env = { ...process.env }
  const javaHome = setting('java-home', env.JAVA_HOME)
  if (javaHome) env.JAVA_HOME = resolve(root, javaHome)
  const java = env.JAVA_HOME
    ? join(
        env.JAVA_HOME,
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java',
      )
    : 'java'
  const version = spawnSync(java, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  if (version.error) throw version.error
  if (
    version.status !== 0 ||
    !/version "17(?:\.|"|-)/u.test(`${version.stdout}${version.stderr}`)
  )
    throw new Error('Android requires JDK 17; set JAVA_HOME or --java-home.')
  const sdk = setting(
    'sdk',
    launcher.sdk || env.ANDROID_HOME || env.ANDROID_SDK_ROOT,
  )
  if (!sdk)
    throw new Error('Set ANDROID_HOME or configure sdk in android-build.json.')
  env.ANDROID_HOME = resolve(root, sdk)
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME
  if (
    !existsSync(
      join(env.ANDROID_HOME, 'platforms', 'android-36', 'android.jar'),
    )
  )
    throw new Error(`Android API 36 is missing from ${env.ANDROID_HOME}`)
  const gradleHome = setting(
    'gradle-home',
    env.GRADLE_USER_HOME || join(homedir(), '.gradle'),
  )
  env.GRADLE_USER_HOME = resolve(root, gradleHome)
  const wrapper = join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (!existsSync(wrapper))
    throw new Error(`Gradle Wrapper is missing: ${wrapper}`)
  const gradleArgs = [
    '-classpath',
    wrapper,
    'org.gradle.wrapper.GradleWrapperMain',
    '-Pandroid.overridePathCheck=true',
    '-Pkotlin.compiler.execution.strategy=in-process',
    '--max-workers=2',
    '--no-daemon',
    '--no-configuration-cache',
    '--console=plain',
  ]
  // Java 17 reads worker @argfiles using Windows ACP. Gradle must write those
  // files in the same encoding when this checkout/cache contains Chinese paths.
  // Only the test launcher changes; Kotlin/XML/Java source files remain UTF-8.
  if (
    action === 'test' &&
    process.platform === 'win32' &&
    /[^\x00-\x7F]/u.test(`${project}${env.GRADLE_USER_HOME}`)
  ) {
    const codePage = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Text.Encoding]::Default.CodePage',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    )
    if (codePage.status === 0 && codePage.stdout.trim() === '936') {
      gradleArgs.push('-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=GBK')
      console.log(
        'Android JVM tests: using Windows ACP 936 for Java 17 worker argument files.',
      )
    }
  }
  const initScript = setting('init-script')
  if (initScript) {
    const path = resolve(root, initScript)
    if (!existsSync(path))
      throw new Error(`Gradle init script is missing: ${path}`)
    gradleArgs.push('--init-script', path)
  }
  if (setting('offline', false)) gradleArgs.push('--offline')
  const server = setting('server')
  if (server) {
    const url = new URL(server)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        'The Debug server must be an HTTP(S) URL without credentials.',
      )
    gradleArgs.push(`-PagentsAnywhere.serverUrl=${server}`)
  }
  gradleArgs.push(...actions[action])
  console.log(
    `Android ${action}: ${project}\nGradle cache: ${env.GRADLE_USER_HOME}`,
  )
  const child = spawn(java, gradleArgs, {
    cwd: project,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const code = await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`Gradle stopped by ${signal}`))
      else accept(exitCode ?? 1)
    })
  })
  process.exitCode = code
  if (code === 0 && action === 'build')
    console.log(
      `APK: ${join(project, 'app/build/outputs/apk/debug/app-debug.apk')}`,
    )
}

main().catch((error) => {
  console.error(`Android command failed: ${error.message}`)
  process.exitCode = 1
})
