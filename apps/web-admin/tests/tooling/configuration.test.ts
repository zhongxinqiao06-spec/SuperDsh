import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'
import {
  deploymentMetadata,
  composeEnvironment as composeBaseEnvironment,
  loadConfiguration as loadBaseConfiguration,
} from '../../scripts/configuration.ts'
import { defaultModelDefaultsFile } from '../../scripts/model-defaults.ts'
import {
  providerAllowedOrigins,
  providerOriginsEnvironment,
} from '../../scripts/provider-origins.ts'

/** 测试显式指定合成模型文件，不能读写后端 config 中的真实密钥。 */
function loadConfiguration(mode: string, directory: string) {
  return loadBaseConfiguration(
    mode,
    directory,
    resolve(directory, 'model-defaults.json'),
  )
}

function composeEnvironment(mode: string, directory: string) {
  return composeBaseEnvironment(
    mode,
    directory,
    undefined,
    resolve(directory, 'model-defaults.json'),
  )
}

test('正式模型配置只补空模板，重启保留内容，开发与生产导出正确路径', async () => {
  const context = await fixture()
  try {
    const development = await loadConfiguration(
      'development',
      context.directory,
    )
    const path = development.environment.WEB_ADMIN_MODEL_DEFAULTS_FILE
    assert.equal(
      defaultModelDefaultsFile,
      resolve(
        repositoryRoot,
        'apps/web-admin/backend/config/model-defaults.json',
      ),
    )
    assert.equal(path, resolve(context.directory, 'model-defaults.json'))
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      connections: [],
      configurations: [],
      defaults: {},
    })
    const configured = JSON.stringify({
      connections: [{ apiKey: 'synthetic-only' }],
    })
    await writeFile(path, configured)
    await loadConfiguration('development', context.directory)
    assert.equal(await readFile(path, 'utf8'), configured)
    const production = await loadConfiguration(
      'production',
      resolve(context.directory, 'production'),
    )
    assert.equal(
      production.environment.WEB_ADMIN_MODEL_DEFAULTS_FILE,
      '/app/apps/web-admin/backend/config/model-defaults.json',
    )
    const compose = await readFile(
      resolve(repositoryRoot, 'compose.web-admin.yml'),
      'utf8',
    )
    assert.match(
      compose,
      /source: \$\{WEB_ADMIN_MODEL_DEFAULTS_SOURCE:-[^}]+\}/u,
    )
    assert.match(
      compose,
      /target: \/app\/apps\/web-admin\/backend\/config\/model-defaults\.json\s+read_only: true/u,
    )
    assert.equal('WEB_ADMIN_MODEL_API_KEY' in production.environment, false)
  } finally {
    await context.cleanup()
  }
})

/** 配置验证使用隔离目录，不触碰开发/生产密钥或日常运行数据库。 */
async function fixture() {
  const root = resolve(repositoryRoot, '.superdsh-work/web-admin-validation')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(resolve(root, 'configuration-'))
  const cleanup = async () => {
    const child = relative(root, directory)
    assert.ok(child && !child.startsWith(`..${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
  return { directory, cleanup }
}

test('重复初始化复用原密钥，生产Compose与开发目录明确隔离', async () => {
  const context = await fixture()
  try {
    const first = await loadConfiguration('development', context.directory)
    const second = await loadConfiguration('development', context.directory)
    assert.equal(
      first.environment.WEB_ADMIN_SECRET,
      second.environment.WEB_ADMIN_SECRET,
    )
    assert.equal(
      first.environment.WEB_ADMIN_ENCRYPTION_KEY,
      second.environment.WEB_ADMIN_ENCRYPTION_KEY,
    )
    assert.ok(
      first.environment.WEB_ADMIN_DATA_DIR.startsWith(context.directory),
    )
    assert.equal(first.environment.WEB_ADMIN_INITIAL_ADMIN_USERNAME, 'admin')
    assert.equal(first.environment.WEB_ADMIN_INITIAL_ADMIN_PASSWORD, 'admin123')
    assert.equal(first.configuration.setupToken, undefined)
    await assert.rejects(
      loadConfiguration('production', context.directory),
      /归属/,
    )
    const compose = await composeEnvironment('development', context.directory)
    const env = await readFile(compose.envFile, 'utf8')
    assert.match(env, /WEB_ADMIN_IMAGE_PYTHON=/)
    assert.match(env, /WEB_ADMIN_ALLOWED_ORIGINS='\[/)
    assert.match(env, /WEB_ADMIN_INITIAL_ADMIN_USERNAME='admin'/)
    assert.doesNotMatch(env, /WEB_ADMIN_SETUP_TOKEN/)
  } finally {
    await context.cleanup()
  }
})

test('生产再次导出保留数据库变体、公开地址和模型文件', async () => {
  const context = await fixture()
  const previousModel = process.env.WEB_ADMIN_MODEL_DEFAULTS_FILE
  const previousOrigin = process.env.WEB_ADMIN_PUBLIC_ORIGIN
  delete process.env.WEB_ADMIN_MODEL_DEFAULTS_FILE
  delete process.env.WEB_ADMIN_PUBLIC_ORIGIN
  try {
    const models = resolve(context.directory, 'private-models.json')
    const initial = await loadBaseConfiguration(
      'production',
      context.directory,
      models,
    )
    Object.assign(initial.configuration, {
      postgresVariant: 'bookworm',
      publicOrigin: 'https://platform.example.com',
      modelDefaultsFile: models,
    })
    await writeFile(initial.configPath, JSON.stringify(initial.configuration))
    const result = await composeBaseEnvironment('production', context.directory)
    assert.equal(result.modelDefaultsFile, models)
    assert.equal(
      result.environment.WEB_ADMIN_PUBLIC_ORIGIN,
      'https://platform.example.com',
    )
    const env = await readFile(result.envFile, 'utf8')
    assert.match(env, /COMPOSE_FILE='compose.yml'/)
    assert.match(
      env,
      /WEB_ADMIN_IMAGE_POSTGRES='postgres:17-bookworm@sha256:[a-f0-9]{64}'/,
    )
  } finally {
    if (previousModel !== undefined)
      process.env.WEB_ADMIN_MODEL_DEFAULTS_FILE = previousModel
    if (previousOrigin !== undefined)
      process.env.WEB_ADMIN_PUBLIC_ORIGIN = previousOrigin
    await context.cleanup()
  }
})

test('旧配置补齐初始管理员并保留密钥，用户自定义值重复加载不覆盖', async () => {
  const context = await fixture()
  try {
    const first = await loadConfiguration('development', context.directory)
    const previous = { ...first.configuration }
    delete previous.initialAdmin
    await writeFile(first.configPath, JSON.stringify(previous))
    const upgraded = await loadConfiguration('development', context.directory)
    assert.deepEqual(
      { ...upgraded.configuration, initialAdmin: undefined },
      { ...previous, initialAdmin: undefined },
    )
    const persisted = JSON.parse(await readFile(first.configPath, 'utf8'))
    assert.equal(persisted.initialAdmin.username, 'admin')
    persisted.initialAdmin = {
      username: 'custom_admin',
      password: 'synthetic-password',
      displayName: '自定义管理员',
    }
    await writeFile(first.configPath, JSON.stringify(persisted))
    const custom = await loadConfiguration('development', context.directory)
    assert.equal(
      custom.environment.WEB_ADMIN_INITIAL_ADMIN_USERNAME,
      'custom_admin',
    )
    assert.equal(
      custom.environment.WEB_ADMIN_INITIAL_ADMIN_PASSWORD,
      'synthetic-password',
    )
    assert.equal(custom.configuration.secret, previous.secret)
    persisted.initialAdmin.password = ''
    await writeFile(first.configPath, JSON.stringify(persisted))
    await assert.rejects(
      loadConfiguration('development', context.directory),
      /initialAdmin/,
    )
    assert.deepEqual(
      JSON.parse(await readFile(first.configPath, 'utf8')),
      persisted,
    )
  } finally {
    await context.cleanup()
  }
})

test('已有运行数据却丢失配置时拒绝生成另一套密钥', async () => {
  const context = await fixture()
  try {
    await mkdir(resolve(context.directory, 'runtime'))
    await writeFile(
      resolve(context.directory, 'runtime/ownership.txt'),
      'synthetic data marker',
    )
    await assert.rejects(
      loadConfiguration('development', context.directory),
      /恢复原密钥/,
    )
  } finally {
    await context.cleanup()
  }
})

test('供应商来源只接受精确绝对 origin，规范化且去重', () => {
  assert.deepEqual(providerAllowedOrigins(undefined), [])
  assert.deepEqual(
    providerAllowedOrigins([
      'https://API.example.test:443',
      'https://api.example.test',
      'http://127.0.0.1:8123',
      'http://[::1]:8123',
    ]),
    ['https://api.example.test', 'http://127.0.0.1:8123', 'http://[::1]:8123'],
  )
  for (const value of [
    null,
    'https://api.example.test',
    {},
    [1],
    [''],
    ['*'],
    ['api.example.test'],
    ['//api.example.test'],
    ['ftp://api.example.test'],
    ['https://user:password@api.example.test'],
    ['https://@api.example.test'],
    ['https://api.example.test/'],
    ['https://api.example.test/v1'],
    ['https://api.example.test?'],
    ['https://api.example.test?token=synthetic'],
    ['https://api.example.test#'],
    ['https://*.example.test'],
    ['https://%2a.example.test'],
    ['https://first.example.test,second.example.test'],
    ['https://first.example.test%2csecond.example.test'],
    ['https://api.example.test:invalid'],
    ['https://api.example.test\\private'],
    [' https://api.example.test'],
    ['https://api.\nexample.test'],
  ])
    assert.throws(() => providerAllowedOrigins(value), /providerAllowedOrigins/)
})

test('供应商 origin 环境覆盖保持严格校验，显式空值关闭放行', () => {
  const configured = ['https://configured.example.test']
  assert.equal(
    providerOriginsEnvironment(configured),
    'https://configured.example.test',
  )
  assert.equal(
    providerOriginsEnvironment(
      configured,
      'https://override.example.test, http://localhost:8123',
    ),
    'https://override.example.test,http://localhost:8123',
  )
  assert.equal(providerOriginsEnvironment(configured, ''), '')
  assert.throws(
    () => providerOriginsEnvironment(configured, '*'),
    /providerAllowedOrigins/,
  )
  assert.throws(
    () => providerOriginsEnvironment(configured, 'https://api.example.test,'),
    /providerAllowedOrigins/,
  )
  assert.throws(
    () => providerOriginsEnvironment(['https://api.example.test/path'], ''),
    /providerAllowedOrigins/,
  )
})

test('配置及 Compose 导出供应商来源，环境覆盖不写回原配置', async () => {
  const context = await fixture()
  const original = process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS
  try {
    delete process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS
    const initial = await loadConfiguration('development', context.directory)
    assert.deepEqual(initial.configuration.providerAllowedOrigins, [])
    assert.equal(initial.environment.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS, '')
    initial.configuration.providerAllowedOrigins = [
      'https://first.example.test',
      'https://second.example.test',
    ]
    const persisted = JSON.stringify(initial.configuration)
    await writeFile(initial.configPath, persisted)
    const loaded = await loadConfiguration('development', context.directory)
    assert.equal(
      loaded.environment.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS,
      'https://first.example.test,https://second.example.test',
    )
    const compose = await composeEnvironment('development', context.directory)
    assert.match(
      await readFile(compose.envFile, 'utf8'),
      /WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS='https:\/\/first.example.test,https:\/\/second.example.test'/u,
    )
    process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS =
      'https://override.example.test'
    const overridden = await loadConfiguration('development', context.directory)
    assert.equal(
      overridden.environment.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS,
      'https://override.example.test',
    )
    assert.equal(await readFile(initial.configPath, 'utf8'), persisted)
    initial.configuration.providerAllowedOrigins = [
      'https://invalid.example.test/path',
    ]
    const invalid = JSON.stringify(initial.configuration)
    await writeFile(initial.configPath, invalid)
    await assert.rejects(
      loadConfiguration('development', context.directory),
      /providerAllowedOrigins/,
    )
    assert.equal(await readFile(initial.configPath, 'utf8'), invalid)
    delete initial.configuration.providerAllowedOrigins
    const legacy = JSON.stringify(initial.configuration)
    await writeFile(initial.configPath, legacy)
    delete process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS
    const missing = await loadConfiguration('development', context.directory)
    assert.equal(missing.environment.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS, '')
    assert.equal(await readFile(initial.configPath, 'utf8'), legacy)
  } finally {
    if (original === undefined)
      delete process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS
    else process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS = original
    await context.cleanup()
  }
})

test('直接 Compose 启动使用与发布工具相同的固定构建输入', async () => {
  const { parseEnv } = await import('node:util')
  const env = parseEnv(
    await readFile(
      resolve(repositoryRoot, 'apps/web-admin/deployment/compose-defaults.env'),
      'utf8',
    ),
  )
  for (const [name, image] of Object.entries(deploymentMetadata.images))
    assert.equal(env[`WEB_ADMIN_IMAGE_${name.toUpperCase()}`], image)
  assert.equal(env.WEB_ADMIN_UV_VERSION, deploymentMetadata.uvVersion)
  const storage = deploymentMetadata.storage
  assert.deepEqual(
    [
      env.WEB_ADMIN_MINIO_SOURCE,
      env.WEB_ADMIN_MINIO_SHA256,
      env.WEB_ADMIN_MC_SOURCE,
      env.WEB_ADMIN_MC_SHA256,
      env.WEB_ADMIN_STORAGE_BUCKET,
    ],
    [
      storage.minioSource,
      storage.minioSha256,
      storage.mcSource,
      storage.mcSha256,
      storage.bucket,
    ],
  )
})
