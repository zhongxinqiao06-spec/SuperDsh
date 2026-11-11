import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'

const execute = promisify(execFile)

/** 使用独立虚拟环境复现旧 Windows redirector 的基础解释器失效，不接触运行数据。 */
test(
  'prepare 从空目录安装锁定依赖，并修复 Windows 虚拟环境失效的基础 Python',
  { skip: process.platform !== 'win32', timeout: 180_000 },
  async () => {
    const validationRoot = resolve(
      repositoryRoot,
      '.superdsh-work/web-admin-validation',
    )
    await mkdir(validationRoot, { recursive: true })
    const directory = await mkdtemp(resolve(validationRoot, 'python-startup-'))
    const lockPath = resolve(backendRoot, 'uv.lock')
    const lockHash = async () =>
      createHash('sha256')
        .update(await readFile(lockPath))
        .digest('hex')
    const originalLock = await lockHash()
    try {
      const base = await execute(
        pythonExecutable(),
        [
          '-I',
          '-B',
          '-c',
          'import json, sys; print(json.dumps(sys._base_executable))',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      )
      // -I 会忽略 PYTHONUTF8；用 ASCII JSON 传递中文路径，不能按终端代码页猜测。
      const baseExecutable: unknown = JSON.parse(base.stdout)
      assert.ok(typeof baseExecutable === 'string')
      const environment = pythonEnvironment({
        UV_PROJECT_ENVIRONMENT: resolve(directory, 'venv'),
        PYTHONPYCACHEPREFIX: resolve(directory, 'pycache'),
        UV_PYTHON_INSTALL_DIR: dirname(dirname(baseExecutable)),
      })
      const prepare = async () => {
        const result = await execute(
          process.execPath,
          ['scripts/web-admin.ts', 'prepare'],
          {
            cwd: repositoryRoot,
            env: environment,
            windowsHide: true,
            timeout: 80_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        )
        assert.match(result.stdout, /Python 环境就绪/u)
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /MODULE_TYPELESS_PACKAGE_JSON|tsdown|buildkit|Dockerfile/u,
        )
      }
      const imports = async () => {
        const result = await execute(
          pythonExecutable(environment),
          ['-I', '-B', '-c', 'import fastapi, alembic; print("ready")'],
          { env: environment, windowsHide: true, timeout: 15_000 },
        )
        assert.equal(result.stdout.trim(), 'ready')
      }

      await prepare()
      await imports()
      const configPath = resolve(
        environment.UV_PROJECT_ENVIRONMENT,
        'pyvenv.cfg',
      )
      const config = await readFile(configPath, 'utf8')
      assert.match(config, /^home = .+$/mu)
      // 新 uv trampoline 内嵌基础路径；用 CPython 自带的真实旧启动器复现用户的旧环境。
      // 先 unlink 本测试的可执行文件，避免覆写潜在硬链接时修改共享缓存或基础解释器。
      const legacyLauncher = resolve(
        dirname(baseExecutable),
        'Lib/venv/scripts/nt/python.exe',
      )
      const temporaryExecutable = pythonExecutable(environment)
      await unlink(temporaryExecutable)
      await copyFile(legacyLauncher, temporaryExecutable)
      await imports()
      // 仅修改本测试创建的配置；真实启动器仍存在，但失效 home 必须阻止运行。
      await writeFile(
        configPath,
        config
          .replace(
            /^home = .+$/mu,
            `home = ${resolve(directory, 'missing-python')}`,
          )
          .replace(
            /^executable = .+$/mu,
            `executable = ${resolve(directory, 'missing-python/python.exe')}`,
          ),
      )
      await assert.rejects(imports(), /No Python at/u)
      await prepare()
      await imports()
      assert.equal(await lockHash(), originalLock)
    } finally {
      const child = relative(validationRoot, directory)
      assert.ok(child && !isAbsolute(child) && !child.startsWith(`..${sep}`))
      await rm(directory, { recursive: true, force: true })
    }
  },
)
