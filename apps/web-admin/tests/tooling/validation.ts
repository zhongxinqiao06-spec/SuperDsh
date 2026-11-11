import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'
import { deploymentMetadata } from '../../scripts/configuration.ts'

/** 自测资源只属于本次 run；finally 清理账号、数据库、Home 与过程产物。 */
export async function validationEnvironment() {
  const id = `check-${Date.now()}-${randomUUID().slice(0, 8)}`
  const validationRoot = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation',
  )
  const directory = resolve(validationRoot, id)
  await mkdir(directory, { recursive: true })
  const modelDefaultsFile = resolve(directory, 'model-defaults.json')
  await writeFile(
    modelDefaultsFile,
    JSON.stringify({ connections: [], configurations: [], defaults: {} }),
  )
  const containerNames: string[] = []
  const docker = (args: string[]) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const password = randomBytes(24).toString('hex')
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    WEB_ADMIN_VALIDATION_DIR: directory,
    WEB_ADMIN_MODEL_DEFAULTS_FILE: modelDefaultsFile,
    PYTHONPYCACHEPREFIX: resolve(directory, 'pycache'),
    PYTEST_ADDOPTS: '-p no:cacheprovider',
    RUFF_CACHE_DIR: resolve(directory, 'ruff'),
    MYPY_CACHE_DIR: resolve(directory, 'mypy'),
    WEB_ADMIN_DATA_DIR: resolve(directory, 'runtime'),
    WEB_ADMIN_SECRET: randomBytes(48).toString('hex'),
    WEB_ADMIN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    WEB_ADMIN_SETUP_TOKEN: randomBytes(24).toString('hex'),
    WEB_ADMIN_SETUP_TOKEN_EXPIRES_AT: new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString(),
    // 基础测试不继承宿主机初始账号；真实浏览器用例再显式注入合成管理员。
    WEB_ADMIN_INITIAL_ADMIN_USERNAME: '',
    WEB_ADMIN_INITIAL_ADMIN_PASSWORD: '',
    WEB_ADMIN_INITIAL_ADMIN_DISPLAY_NAME: '',
  }
  // 所有子进程显式读取上方合成文件，不能回落到后端 config 中的真实凭据。
  const cleanup = async () => {
    for (const name of containerNames.reverse()) {
      try {
        const label = docker([
          'inspect',
          '--format',
          '{{index .Config.Labels "superdsh.validation"}}',
          name,
        ])
        if (label !== id) throw new Error(`拒绝删除非本轮容器 ${name}`)
        docker(['rm', '-f', '-v', name])
      } catch (error) {
        if (!String(error).includes('No such')) throw error
      }
    }
    const checked = relative(validationRoot, directory)
    if (
      !checked ||
      checked.startsWith(`..${sep}`) ||
      resolve(validationRoot, checked) !== directory
    )
      throw new Error('拒绝清理验证目录之外的路径')
    await rm(directory, { recursive: true, force: true })
    console.log('本轮临时容器、数据库、Home 与测试过程文件已清理')
  }
  try {
    const postgres = `web-admin-${id}-pg`
    docker([
      'run',
      '-d',
      '--name',
      postgres,
      '--label',
      `superdsh.validation=${id}`,
      '-e',
      'POSTGRES_USER=web_admin_test',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=web_admin_test',
      '-p',
      '127.0.0.1::5432',
      deploymentMetadata.images.postgres,
    ])
    containerNames.push(postgres)
    const redis = `web-admin-${id}-redis`
    docker([
      'run',
      '-d',
      '--name',
      redis,
      '--label',
      `superdsh.validation=${id}`,
      '-p',
      '127.0.0.1::6379',
      deploymentMetadata.images.redis,
    ])
    containerNames.push(redis)
    const pgPort = docker(['port', postgres, '5432/tcp']).split(':').at(-1)
    const redisPort = docker(['port', redis, '6379/tcp']).split(':').at(-1)
    environment.WEB_ADMIN_TEST_DATABASE_URL = `postgresql+asyncpg://web_admin_test:${password}@127.0.0.1:${pgPort}/web_admin_test`
    environment.WEB_ADMIN_TEST_REDIS_URL = `redis://127.0.0.1:${redisPort}/0`
    environment.WEB_ADMIN_DATABASE_URL = environment.WEB_ADMIN_TEST_DATABASE_URL
    environment.WEB_ADMIN_REDIS_URL = environment.WEB_ADMIN_TEST_REDIS_URL
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        docker([
          'exec',
          postgres,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'web_admin_test',
          '-d',
          'web_admin_test',
        ])
        ready = true
        break
      } catch {
        await new Promise((done) => setTimeout(done, 500))
      }
    }
    if (!ready) throw new Error('临时数据库未就绪')
    docker([
      'exec',
      postgres,
      'createdb',
      '-h',
      '127.0.0.1',
      '-U',
      'web_admin_test',
      'web_admin_dsh_test',
    ])
    environment.WEB_ADMIN_DSH_TEST_DATABASE_URL =
      environment.WEB_ADMIN_TEST_DATABASE_URL.replace(
        /\/web_admin_test$/u,
        '/web_admin_dsh_test',
      )
    await writeFile(
      resolve(directory, 'ownership.json'),
      JSON.stringify({ id, containerNames, directory }),
    )
    return { directory, environment, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
