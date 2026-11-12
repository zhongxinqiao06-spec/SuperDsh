import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { appRoot, developmentRoot, repositoryRoot } from './paths.ts'
import { initialAdminConfiguration } from './initial-admin.ts'
import { providerOriginsEnvironment } from './provider-origins.ts'
import { ensureModelDefaults } from './model-defaults.ts'

interface RuntimeMetadata {
  uvVersion: string
  builder: { image: string }
  toolchain: { node: string; python: string }
  images: Record<
    | 'node'
    | 'python'
    | 'nginx'
    | 'postgres'
    | 'redis'
    | 'qdrant'
    | 'minio'
    | 'go'
    | 'alpine',
    string
  >
  postgresBookworm: string
  storage: {
    bucket: string
    minioSource: string
    minioSha256: string
    mcSource: string
    mcSha256: string
  }
  development: {
    frontedPort: number
    backendPort: number
    postgresPort: number
    redisPort: number
    qdrantPort: number
    minioPort: number
  }
}

export const deploymentMetadata: RuntimeMetadata = JSON.parse(
  await readFile(resolve(appRoot, 'deployment/runtime.json'), 'utf8'),
)

/** 配置只创建一次；发现已有运行空间但密钥缺失时拒绝初始化，防止旧数据无法解密。 */
export async function loadConfiguration(
  mode = 'development',
  directory?: string,
  modelDefaultsFile?: string,
) {
  const root = resolve(
    directory ??
      (mode === 'production'
        ? resolve(repositoryRoot, '.superdsh-work/web-admin-production')
        : developmentRoot),
  )
  const configPath = resolve(root, 'config/settings.json')
  let configuration
  let providerOrigins: string
  if (existsSync(configPath)) {
    configuration = JSON.parse(await readFile(configPath, 'utf8'))
    if (
      configuration.owner !== 'superdsh-web-admin' ||
      configuration.mode !== mode ||
      !configuration.secret ||
      !configuration.encryptionKey
    ) {
      throw new Error('新管理端配置归属或密钥不完整，拒绝覆盖')
    }
    providerOrigins = providerOriginsEnvironment(
      configuration.providerAllowedOrigins,
      process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS,
    )
    const missingInitialAdmin = configuration.initialAdmin === undefined
    configuration.initialAdmin = await initialAdminConfiguration(
      configuration.initialAdmin,
    )
    if (missingInitialAdmin) {
      // 旧开发配置只补充新字段，保留原密钥与端口；原子替换避免中途退出写坏配置。
      const temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`
      await writeFile(
        temporary,
        `${JSON.stringify(configuration, null, 2)}\n`,
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
      await rename(temporary, configPath)
    }
  } else {
    const runtime = resolve(root, 'runtime')
    if (existsSync(runtime) && (await readdir(runtime)).length)
      throw new Error('发现运行数据但缺少配置，请恢复原密钥')
    configuration = {
      owner: 'superdsh-web-admin',
      mode,
      secret: randomBytes(48).toString('base64url'),
      encryptionKey: randomBytes(32).toString('base64url'),
      databasePassword: randomBytes(32).toString('hex'),
      redisPassword: randomBytes(32).toString('hex'),
      qdrantKey: randomBytes(32).toString('hex'),
      storagePassword: randomBytes(32).toString('hex'),
      initialAdmin: await initialAdminConfiguration(),
      providerAllowedOrigins: [],
      ports: deploymentMetadata.development,
    }
    providerOrigins = providerOriginsEnvironment(
      configuration.providerAllowedOrigins,
      process.env.WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS,
    )
    await mkdir(resolve(root, 'config'), { recursive: true })
    // wx 防止并发初始化各自生成密钥；已存在时显式重试读取，不覆盖。
    await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
  }
  for (const child of ['runtime', 'files', 'logs'])
    await mkdir(resolve(root, child), { recursive: true })
  const modelDefaults = await ensureModelDefaults(
    modelDefaultsFile ??
      process.env.WEB_ADMIN_MODEL_DEFAULTS_FILE ??
      configuration.modelDefaultsFile,
  )
  const ports = configuration.ports
  const host = mode === 'production' ? 'postgres' : '127.0.0.1'
  const dbPort = mode === 'production' ? 5432 : ports.postgresPort
  const publicOrigin =
    process.env.WEB_ADMIN_PUBLIC_ORIGIN ??
    configuration.publicOrigin ??
    `http://localhost:${ports.frontedPort}`
  const environment = {
    WEB_ADMIN_DATABASE_URL: `postgresql+asyncpg://web_admin:${configuration.databasePassword}@${host}:${dbPort}/web_admin`,
    WEB_ADMIN_REDIS_URL: `redis://:${configuration.redisPassword}@${mode === 'production' ? 'redis:6379' : `127.0.0.1:${ports.redisPort}`}/0`,
    WEB_ADMIN_SECRET: configuration.secret,
    WEB_ADMIN_ENCRYPTION_KEY: configuration.encryptionKey,
    WEB_ADMIN_INITIAL_ADMIN_USERNAME: configuration.initialAdmin.username,
    WEB_ADMIN_INITIAL_ADMIN_PASSWORD: configuration.initialAdmin.password,
    WEB_ADMIN_INITIAL_ADMIN_DISPLAY_NAME:
      configuration.initialAdmin.displayName,
    WEB_ADMIN_DATA_DIR:
      mode === 'production' ? '/data/runtime' : resolve(root, 'runtime'),
    WEB_ADMIN_RUNTIME_STATE_ROOT:
      mode === 'production' ? '/data/runtime' : resolve(root, 'runtime'),
    WEB_ADMIN_PUBLIC_ORIGIN: publicOrigin,
    WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([publicOrigin]),
    WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS: providerOrigins,
    WEB_ADMIN_MODEL_DEFAULTS_FILE:
      mode === 'production'
        ? '/app/apps/web-admin/backend/config/model-defaults.json'
        : modelDefaults,
    WEB_ADMIN_REPOSITORY_ROOT: mode === 'production' ? '/app' : repositoryRoot,
    WEB_ADMIN_QDRANT_URL:
      mode === 'production'
        ? 'http://qdrant:6333'
        : `http://127.0.0.1:${ports.qdrantPort}`,
    WEB_ADMIN_QDRANT_API_KEY: configuration.qdrantKey,
    WEB_ADMIN_STORAGE_ENDPOINT:
      mode === 'production'
        ? 'http://minio:9000'
        : `http://127.0.0.1:${ports.minioPort}`,
    WEB_ADMIN_STORAGE_USER: 'web-admin',
    WEB_ADMIN_STORAGE_BUCKET: deploymentMetadata.storage.bucket,
    WEB_ADMIN_STORAGE_PASSWORD: configuration.storagePassword,
  }
  return {
    root,
    configPath,
    configuration,
    environment,
    modelDefaultsFile: modelDefaults,
  }
}

/** Compose 从集中镜像清单与持久配置派生环境，重复启动不会轮换凭据。 */
export async function composeEnvironment(
  mode = 'development',
  directory?: string,
  project = mode === 'production'
    ? 'starbridge-web-admin'
    : 'superdsh-web-admin-dev',
  modelDefaultsFile?: string,
) {
  const rootPath = resolve(
    directory ??
      (mode === 'production'
        ? resolve(repositoryRoot, '.superdsh-work/web-admin-production')
        : developmentRoot),
  )
  // Compose 数据在命名卷中；配置丢失不能仅根据宿主机空目录判断为首次安装。
  if (!existsSync(resolve(rootPath, 'config/settings.json'))) {
    const volumes = execFileSync(
      'docker',
      [
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.Name}}',
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
    if (volumes)
      throw new Error('发现已有 Compose 数据卷但缺少配置，请恢复原密钥')
  }
  const loaded = await loadConfiguration(mode, directory, modelDefaultsFile)
  const { configuration: config, environment, root } = loaded
  const values: Record<string, string | number> = {
    ...environment,
    WEB_ADMIN_CONFIG_DIR: resolve(root, 'config').replaceAll('\\', '/'),
    WEB_ADMIN_MODEL_DEFAULTS_SOURCE: loaded.modelDefaultsFile.replaceAll(
      '\\',
      '/',
    ),
    WEB_ADMIN_POSTGRES_PASSWORD: config.databasePassword,
    WEB_ADMIN_REDIS_PASSWORD: config.redisPassword,
    WEB_ADMIN_MINIO_PASSWORD: config.storagePassword,
    WEB_ADMIN_FRONTED_PORT: config.ports.frontedPort,
    WEB_ADMIN_BACKEND_PORT: config.ports.backendPort,
    WEB_ADMIN_POSTGRES_PORT: config.ports.postgresPort,
    WEB_ADMIN_REDIS_PORT: config.ports.redisPort,
    WEB_ADMIN_QDRANT_PORT: config.ports.qdrantPort,
    WEB_ADMIN_MINIO_PORT: config.ports.minioPort,
    WEB_ADMIN_SOURCE_COMMIT:
      process.env.WEB_ADMIN_SOURCE_COMMIT ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim(),
    WEB_ADMIN_UV_VERSION: deploymentMetadata.uvVersion,
    WEB_ADMIN_MINIO_SOURCE: deploymentMetadata.storage.minioSource,
    WEB_ADMIN_MINIO_SHA256: deploymentMetadata.storage.minioSha256,
    WEB_ADMIN_MC_SOURCE: deploymentMetadata.storage.mcSource,
    WEB_ADMIN_MC_SHA256: deploymentMetadata.storage.mcSha256,
  }
  if (mode === 'production') {
    values.COMPOSE_FILE = 'compose.yml'
    values.WEB_ADMIN_APP_PULL_POLICY = 'never'
  }
  for (const [name, value] of Object.entries(deploymentMetadata.images))
    values[`WEB_ADMIN_IMAGE_${name.toUpperCase()}`] = value
  // 已有数据卷须保持 initdb 时的系统变体，后续发布继续读取同一选择。
  if (config.postgresVariant === 'bookworm')
    values.WEB_ADMIN_IMAGE_POSTGRES = deploymentMetadata.postgresBookworm
  else if (config.postgresVariant && config.postgresVariant !== 'alpine')
    throw new Error('postgresVariant 必须是 alpine 或 bookworm')
  const output = resolve(root, 'config/compose.env')
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}='${String(value).replaceAll("'", "\\'")}'`,
  )
  await writeFile(output, `${lines.join('\n')}\n`, { mode: 0o600 })
  return { ...loaded, envFile: output }
}
