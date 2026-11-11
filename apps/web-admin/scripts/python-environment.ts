import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { deploymentMetadata } from './configuration.ts'
import { backendRoot, repositoryRoot } from './paths.ts'
import { run } from './processes.ts'

const execute = promisify(execFile)
const workRoot = resolve(repositoryRoot, '.superdsh-work')
const toolsRoot = resolve(repositoryRoot, '.superdsh-work/web-admin-tools')
const preparations = new Map<string, Promise<void>>()

/** 解析已存在的父目录，避免缓存经符号链接或 Windows 联接写回源码目录。 */
function resolveCachePath(value: string): string {
  let existing = value
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error('无法解析缓存目录')
    existing = parent
  }
  return resolve(realpathSync(existing), relative(existing, value))
}

/** 缓存必须留在工作目录内；显式错误配置直接失败，不静默改写调用方设置。 */
function cacheDirectory(
  name: string,
  value: string | undefined,
  fallback: string,
) {
  const target = resolve(value ?? resolve(toolsRoot, fallback))
  const within = (root: string, path: string) => {
    const child = relative(root, path)
    return (
      child &&
      !isAbsolute(child) &&
      child !== '..' &&
      !child.startsWith(`..${sep}`)
    )
  }
  if (
    value === '' ||
    !within(workRoot, target) ||
    !within(resolveCachePath(workRoot), resolveCachePath(target))
  )
    throw new Error(`${name} 必须指向项目 .superdsh-work 内的缓存目录`)
  return target
}

/** 虚拟环境路径统一解析，启动、检查及 uv 安装必须使用同一个目标。 */
export function pythonEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, ...overrides }
  return {
    ...environment,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: overrides.PYTHONPATH ?? backendRoot,
    PYTHONPYCACHEPREFIX: cacheDirectory(
      'PYTHONPYCACHEPREFIX',
      environment.PYTHONPYCACHEPREFIX,
      'pycache',
    ),
    UV_PROJECT_ENVIRONMENT: resolve(
      environment.UV_PROJECT_ENVIRONMENT ?? resolve(backendRoot, '.venv'),
    ),
    UV_CACHE_DIR: cacheDirectory(
      'UV_CACHE_DIR',
      environment.UV_CACHE_DIR,
      'uv-cache',
    ),
    RUFF_CACHE_DIR: cacheDirectory(
      'RUFF_CACHE_DIR',
      environment.RUFF_CACHE_DIR,
      'ruff',
    ),
    MYPY_CACHE_DIR: cacheDirectory(
      'MYPY_CACHE_DIR',
      environment.MYPY_CACHE_DIR,
      'mypy',
    ),
    UV_PYTHON_INSTALL_DIR: resolve(
      environment.UV_PYTHON_INSTALL_DIR ?? resolve(toolsRoot, 'python'),
    ),
  }
}

/** 返回已准备的解释器路径；文件存在不代表可执行，实际探测由准备流程完成。 */
export function pythonExecutable(environment = pythonEnvironment()) {
  const executable = resolve(
    environment.UV_PROJECT_ENVIRONMENT,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  if (!existsSync(executable))
    throw new Error('Python 环境未就绪，请运行 yarn web-admin:prepare')
  return executable
}

async function probe(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeout = 15_000,
): Promise<string | undefined> {
  try {
    const result = await execute(command, args, {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
    })
    return result.stdout.trim()
  } catch {
    // 探测失败进入显式安装流程，安装失败则保留原始诊断并中止启动。
    return undefined
  }
}

async function uvCommand(environment: NodeJS.ProcessEnv) {
  const expected = `uv ${deploymentMetadata.uvVersion}`
  const matches = (value?: string) =>
    value === expected || value?.startsWith(`${expected} `)
  if (matches(await probe('uv', ['--version'], environment)))
    return { executable: 'uv', args: [], environment }
  const candidates = process.env.WEB_ADMIN_BOOTSTRAP_PYTHON
    ? [process.env.WEB_ADMIN_BOOTSTRAP_PYTHON]
    : process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', 'python']
  for (const executable of candidates) {
    if (
      !(await probe(
        executable,
        ['-B', '-c', 'import sys; print(sys.executable)'],
        environment,
      ))
    )
      continue
    if (
      matches(await probe(executable, ['-m', 'uv', '--version'], environment))
    )
      return { executable, args: ['-m', 'uv'], environment }
    // 只安装到项目工具目录，不升级用户全局 Python 或其他项目使用的 uv。
    const target = resolve(toolsRoot, 'uv-bootstrap')
    const bootstrapEnvironment = { ...environment, PYTHONPATH: target }
    if (
      !matches(
        await probe(
          executable,
          ['-m', 'uv', '--version'],
          bootstrapEnvironment,
        ),
      )
    ) {
      console.log('安装项目指定的 uv 工具，不修改全局 Python 环境…')
      await mkdir(target, { recursive: true })
      await run(
        executable,
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-warn-script-location',
          '--upgrade',
          '--target',
          target,
          `uv==${deploymentMetadata.uvVersion}`,
        ],
        { env: environment, timeout: 300_000 },
      )
      if (
        !matches(
          await probe(
            executable,
            ['-m', 'uv', '--version'],
            bootstrapEnvironment,
          ),
        )
      )
        throw new Error('项目 uv 安装后校验失败，已停止启动')
    }
    return { executable, args: ['-m', 'uv'], environment: bootstrapEnvironment }
  }
  throw new Error(
    '未找到可用的 uv 或基础 Python。请安装 Python，或通过 WEB_ADMIN_BOOTSTRAP_PYTHON 指定可执行文件后重试',
  )
}

/** 从唯一锁文件导出完整 pip 清单，保留平台条件与校验哈希，不更新依赖版本。 */
export async function exportPythonRequirements() {
  const uv = await uvCommand(pythonEnvironment())
  for (const [filename, group] of [
    ['requirements.txt', '--no-dev'],
    ['requirements-dev.txt', '--all-groups'],
  ] as const) {
    const output = resolve(backendRoot, filename)
    await run(
      uv.executable,
      [
        ...uv.args,
        'export',
        '--format',
        'requirements.txt',
        '--frozen',
        '--no-emit-project',
        '--no-header',
        group,
        '--project',
        backendRoot,
        '--output-file',
        output,
      ],
      {
        env: uv.environment,
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 60_000,
      },
    )
    const content = await readFile(output, 'utf8')
    await writeFile(
      output,
      '# 由 uv.lock 自动生成，包含直接和间接依赖；请勿手动修改。\n' +
        '# 在仓库根目录运行 corepack yarn web-admin:requirements 重新生成。\n' +
        '# Python 兼容范围见 pyproject.toml；uv 安装工具单独按 deployment/runtime.json 准备。\n' +
        content,
    )
    console.log(`已导出 ${filename}`)
  }
}

async function prepare(environment: ReturnType<typeof pythonEnvironment>) {
  const uv = await uvCommand(environment)
  // 原生 uv 与根命令共用后端 .venv；基础解释器归项目管理，不依赖用户 Roaming 目录。
  await run(
    uv.executable,
    [
      ...uv.args,
      'python',
      'install',
      deploymentMetadata.toolchain.python,
      '--install-dir',
      environment.UV_PYTHON_INSTALL_DIR,
      '--no-bin',
      '--no-registry',
    ],
    { env: uv.environment, timeout: 300_000 },
  )
  const managedPythonPath = await probe(
    uv.executable,
    [
      ...uv.args,
      'python',
      'find',
      '--system',
      '--managed-python',
      '--no-python-downloads',
      deploymentMetadata.toolchain.python,
    ],
    uv.environment,
  )
  if (!managedPythonPath)
    throw new Error('项目 Python 安装后无法定位解释器，已停止启动')
  // uv 的次版本入口可能是 junction；虚拟环境绑定实际安装，避免再依赖重解析路径。
  const managedPython = await realpath(managedPythonPath)
  const managedRelative = relative(
    resolve(environment.UV_PYTHON_INSTALL_DIR),
    managedPython,
  )
  if (
    isAbsolute(managedRelative) ||
    managedRelative === '..' ||
    managedRelative.startsWith(`..${sep}`)
  )
    throw new Error('Python 解释器不属于指定工具目录，拒绝复用旧环境')
  let executable: string | undefined
  try {
    executable = pythonExecutable(environment)
  } catch {
    /* 缺失环境交由 uv 创建。 */
  }
  const interpreterProbe =
    'import sys; print(".".join(map(str, sys.version_info[:2])))'
  const healthy =
    executable &&
    (await probe(
      executable,
      ['-I', '-B', '-c', interpreterProbe],
      environment,
    )) === deploymentMetadata.toolchain.python
  console.log(
    healthy
      ? '检查 Python 虚拟环境与锁定依赖…'
      : 'Python 虚拟环境缺失或不可用，正在自动创建／修复并安装锁定依赖…',
  )
  const args = [
    ...uv.args,
    'sync',
    '--python',
    managedPython,
    '--frozen',
    '--no-install-project',
    '--project',
    backendRoot,
  ]
  // uv 负责识别断开的基础解释器并重建 venv；不自行删除目录或触碰业务数据。
  await run(uv.executable, args, { env: uv.environment, timeout: 300_000 })
  executable = pythonExecutable(environment)
  // 检查实际基础解释器，不能仅凭 Python 版本一致就认定旧环境已切换。
  const baseResult = await probe(
    executable,
    ['-I', '-B', '-c', 'import json, sys; print(json.dumps(sys.base_prefix))'],
    environment,
  )
  if (!baseResult)
    throw new Error('虚拟环境重建后无法执行，请检查项目 Python 安装')
  const basePrefix: unknown = JSON.parse(baseResult)
  if (typeof basePrefix !== 'string')
    throw new Error('虚拟环境基础解释器检查结果无效')
  const baseRelative = relative(
    await realpath(environment.UV_PYTHON_INSTALL_DIR),
    await realpath(basePrefix),
  )
  if (
    isAbsolute(baseRelative) ||
    baseRelative === '..' ||
    baseRelative.startsWith(`..${sep}`)
  )
    throw new Error('虚拟环境仍引用指定工具目录之外的 Python，已停止启动')
  const imports =
    'import alembic, asyncpg, fastapi, uvicorn, sqlalchemy, pydantic_settings, cryptography, jwt, jsonschema, httpx, redis, langgraph.graph; print("ready")'
  if (
    (await probe(
      executable,
      ['-I', '-B', '-c', imports],
      environment,
      45_000,
    )) !== 'ready'
  ) {
    // 包元数据存在但模块文件损坏时，普通同步不会修复；只在实际导入失败后重装。
    console.log('Python 依赖导入检查失败，正在重新安装锁定依赖…')
    await run(uv.executable, [...args, '--reinstall'], {
      env: uv.environment,
      timeout: 300_000,
    })
    if (
      (await probe(
        executable,
        ['-I', '-B', '-c', imports],
        environment,
        45_000,
      )) !== 'ready'
    )
      throw new Error(
        'Python 依赖修复后仍无法导入，已停止启动；请检查解释器和依赖安装日志',
      )
  }
  console.log('Python 环境就绪')
}

/** 启动前检查解释器及锁定依赖；同一命令链只准备一次，失败不缓存为成功。 */
export async function ensurePythonEnvironment(
  overrides: NodeJS.ProcessEnv = {},
) {
  const environment = pythonEnvironment(overrides)
  const key = environment.UV_PROJECT_ENVIRONMENT
  let pending = preparations.get(key)
  if (!pending) {
    pending = prepare(environment).catch((error: unknown) => {
      preparations.delete(key)
      throw error
    })
    preparations.set(key, pending)
  }
  await pending
}
