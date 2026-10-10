/** Prepare a product-managed Python 3.12; never select an ambient interpreter. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { privateDirectory } from '../backend/private-files.ts'
import { maskSecrets } from '../backend/mask-secrets.ts'

export interface ConnectorPython {
  executable: string
  python: string
  environment: NodeJS.ProcessEnv
}
export interface ConnectorPythonOptions {
  packageFile: string
  directory: string
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
  diagnostic?(message: string): void
  run?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string>
}
export function connectorPythonEnvironment(
  environment: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const key of [
    'UV_PYTHON',
    'UV_NO_MANAGED_PYTHON',
    'UV_PYTHON_PREFERENCE',
    'UV_PROJECT',
    'UV_WORKING_DIR',
    'UV_CONFIG_FILE',
    'UV_SYSTEM_PYTHON',
    'VIRTUAL_ENV',
    'PYTHONHOME',
    'PYTHONPATH',
    'CONDA_PREFIX',
  ])
    delete result[key]
  return {
    ...result,
    UV_PYTHON_INSTALL_DIR: join(directory, 'python'),
    UV_CACHE_DIR: join(directory, 'uv-cache'),
    UV_MANAGED_PYTHON: '1',
    // Limit first-run SDK downloads and wheel extraction on developer machines.
    UV_CONCURRENT_DOWNLOADS: result.UV_CONCURRENT_DOWNLOADS ?? '2',
    UV_CONCURRENT_BUILDS: result.UV_CONCURRENT_BUILDS ?? '1',
    UV_CONCURRENT_INSTALLS: result.UV_CONCURRENT_INSTALLS ?? '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  }
}
function uvExecutable(packageFile: string): string {
  try {
    const require = createRequire(packageFile)
    const uv = require.resolve('@dataiku/uv/package.json')
    const platform = createRequire(uv).resolve(
      '@dataiku/uv-' + process.platform + '-' + process.arch + '/package.json',
    )
    return join(
      dirname(platform),
      'bin',
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    ).replace(/\.asar([\\/])/, '.asar.unpacked$1')
  } catch {
    return process.env.UV_PATH ?? 'uv'
  }
}
const runPythonCommand = (
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  diagnostic?: (message: string) => void,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      errors = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-16_384)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const safe = maskSecrets(chunk)
      errors = (errors + safe).slice(-8000)
      diagnostic?.('Python 3.12: ' + safe.slice(-2000))
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(output.trim())
      else
        reject(
          new Error('Managed Python command failed (' + code + ')', {
            cause: errors,
          }),
        )
    })
  })
export async function prepareConnectorPython(
  options: ConnectorPythonOptions,
): Promise<ConnectorPython> {
  privateDirectory(options.directory)
  const environment = connectorPythonEnvironment(
    options.environment,
    options.directory,
  )
  const executable = uvExecutable(options.packageFile)
  const run: NonNullable<ConnectorPythonOptions['run']> =
    options.run ??
    ((executable, args, environment, signal) =>
      runPythonCommand(
        executable,
        args,
        environment,
        signal,
        options.diagnostic,
      ))
  const find = [
    'python',
    'find',
    '--no-project',
    '--no-config',
    '--managed-python',
    '--no-python-downloads',
    '3.12',
  ]
  let python: string
  try {
    python = await run(executable, find, environment, options.signal)
  } catch {
    options.signal?.throwIfAborted()
    try {
      await run(
        executable,
        [
          'python',
          'install',
          '--no-config',
          '--no-bin',
          ...(process.platform === 'win32' ? ['--no-registry'] : []),
          '3.12',
        ],
        { ...environment, UV_PYTHON_DOWNLOADS: 'automatic' },
        options.signal,
      )
      python = await run(executable, find, environment, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new Error(
        '本机连接需要 Python 3.12。自动准备失败，请检查网络后重试。',
        { cause: error },
      )
    }
  }
  options.signal?.throwIfAborted()
  if (!python || /[\r\n\0]/.test(python))
    throw new Error('无法定位产品 Python 3.12。')
  const version = await run(
    python,
    ['-I', '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'],
    environment,
    options.signal,
  )
  if (version !== '3.12')
    throw new Error('产品 Python 版本校验失败，需要 Python 3.12。')
  return { executable, python, environment }
}
