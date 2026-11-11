import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appRoot, repositoryRoot } from '../../../scripts/paths.ts'
import { stable, type Observation } from './observations.ts'

interface Sources {
  oldVersion: string
  newVersion: string
  oldSchema: string
  newSchema: string
}
interface Boundary {
  started: number
  finished: number
  oldOrigin: string
  newOrigin: string
}
interface Normalized {
  value: Observation
  rules: string[]
  errors: string[]
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** 诊断版本分别从实际应用元数据和迁移头读取，禁止在比较器写死某次发布版本。 */
export async function normalizationSources(): Promise<Sources> {
  const oldPackage = JSON.parse(
    await readFile(resolve(repositoryRoot, 'apps/admin/package.json'), 'utf8'),
  ) as { version: string }
  const build = JSON.parse(
    await readFile(
      resolve(appRoot, 'backend/resources/build-info.json'),
      'utf8',
    ),
  ) as { version: string }
  const oldSchemaSource = await readFile(
    resolve(repositoryRoot, 'apps/admin/server/infrastructure/schema.ts'),
    'utf8',
  )
  const oldSchema = oldSchemaSource.match(
    /export const schemaVersion = '([^']+)'/u,
  )?.[1]
  const directory = resolve(appRoot, 'backend/migrations/versions')
  const revisions: string[] = [],
    parents = new Set<string>()
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.py')) continue
    const source = await readFile(resolve(directory, file), 'utf8')
    const revision = source.match(
      /^revision(?:\s*:[^=]+)?\s*=\s*["']([^"']+)["']/mu,
    )?.[1]
    const parent = source.match(
      /^down_revision(?:\s*:[^=]+)?\s*=\s*["']([^"']+)["']/mu,
    )?.[1]
    if (revision) revisions.push(revision)
    if (parent) parents.add(parent)
  }
  const heads = revisions.filter((revision) => !parents.has(revision))
  if (!oldSchema || heads.length !== 1)
    throw new Error('无法确定两端真实诊断元数据')
  return {
    oldVersion: oldPackage.version,
    newVersion: build.version,
    oldSchema,
    newSchema: heads[0]!,
  }
}

/** 只对白名单公开诊断/配对字段应用可验证规则；错误、权限和业务序列保持原样。 */
function normalize(
  input: Observation,
  route: string,
  variant: 'old' | 'compatibility' | 'canonical',
  source: Sources,
  boundary: Boundary,
): Normalized {
  const value = structuredClone(input)
  const body = object(value.body)
  const rules: string[] = [],
    errors: string[] = []
  const old = variant === 'old'
  const time = (key: string) => {
    const parsed = typeof body[key] === 'string' ? Date.parse(body[key]) : NaN
    if (
      !Number.isFinite(parsed) ||
      parsed < boundary.started - 1000 ||
      parsed > boundary.finished + 1000
    )
      errors.push(`${key}不在本轮真实时间窗口`)
    else {
      body[key] = '<observed-within-run>'
      rules.push(`${key}:bounded-run-clock`)
    }
    return parsed
  }
  if (route === '/api/v2/auth/config') {
    const server = time('serverTime')
    const expiry =
      typeof body.setupTokenExpiresAt === 'string'
        ? Date.parse(body.setupTokenExpiresAt)
        : NaN
    if (
      !Number.isFinite(expiry) ||
      expiry - server <= 0 ||
      expiry - server > 3_600_000
    )
      errors.push('初始化兼容票据有效期不在0到1小时范围')
    else {
      body.setupTokenExpiresAt = '<valid-setup-window>'
      rules.push('setupTokenExpiresAt:remaining-within-configured-hour')
    }
  } else if (route === '/api/v2/pairing/start') {
    const server = time('serverTime')
    const expiry =
      typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN
    if (!Number.isFinite(expiry) || Math.abs(expiry - server - 300_000) > 2)
      errors.push('配对有效期不是请求默认的300秒')
    else {
      body.expiresAt = '<server-time-plus-300s>'
      rules.push('expiresAt:exact-pairing-duration')
    }
    if (
      typeof body.pairingId !== 'string' ||
      !/^pair_[A-Za-z0-9_-]{20,}$/u.test(body.pairingId)
    )
      errors.push('配对ID形态无效')
    else {
      body.pairingId = '<logical-pairing-created-by-this-request>'
      rules.push('pairingId:single-logical-create-mapping')
    }
    if (typeof body.code !== 'string' || !/^\d{6}$/u.test(body.code))
      errors.push('配对码不是六位数字')
    else {
      body.code = '<six-digit-code>'
      rules.push('code:six-digit-pairing-challenge')
    }
  } else if (route === '/api/v2/.well-known/oauth-authorization-server') {
    const origin = old ? boundary.oldOrigin : boundary.newOrigin
    const prefix = variant === 'canonical' ? '/api' : '/api/v2'
    for (const [key, suffix] of [
      ['issuer', ''],
      ['authorization_endpoint', `${prefix}/oauth/authorize`],
      ['token_endpoint', `${prefix}/oauth/token`],
    ]) {
      if (body[key!] !== origin + suffix)
        errors.push(`${key}没有指向对应服务和入口`)
      else body[key!] = `<same-origin>${suffix?.replace(prefix, '/api')}`
    }
    rules.push('oauth-discovery:explicit-origin-and-declared-ingress')
  } else if (
    ['/api/v2/health', '/api/v2/health/live', '/api/v2/health/ready'].includes(
      route,
    )
  ) {
    time('serverTime')
    if (route.endsWith('/ready')) {
      const database = object(object(body.checks).database)
      if (
        database.schemaVersion !== (old ? source.oldSchema : source.newSchema)
      )
        errors.push('数据库版本不是实际迁移头')
      else {
        database.schemaVersion = '<authoritative-migration-head>'
        rules.push('checks.database.schemaVersion:authoritative-metadata')
      }
      if (
        typeof body.instanceId !== 'string' ||
        !/^[a-f0-9-]{36}$/u.test(body.instanceId)
      )
        errors.push('平台实例身份格式无效')
      else {
        body.instanceId = '<isolated-platform-instance>'
        rules.push('instanceId:distinct-owned-process')
      }
    } else {
      if (body.version !== (old ? source.oldVersion : source.newVersion))
        errors.push('服务版本不是对应包的权威元数据')
      else {
        body.version = '<authoritative-release>'
        rules.push('version:authoritative-metadata')
      }
    }
  }
  return { value, rules, errors }
}

/** 保留原始结果另列规范化证据，不将格式化后的字符串伪称为字节相同。 */
export function compareBoundary(
  route: string,
  observations: {
    old: Observation
    compatibility: Observation
    canonical: Observation
  },
  source: Sources,
  boundary: Boundary,
) {
  const old = normalize(observations.old, route, 'old', source, boundary)
  const compatibility = normalize(
    observations.compatibility,
    route,
    'compatibility',
    source,
    boundary,
  )
  const canonical = normalize(
    observations.canonical,
    route,
    'canonical',
    source,
    boundary,
  )
  const errors = [...old.errors, ...compatibility.errors, ...canonical.errors]
  if (
    route.endsWith('/health/ready') &&
    object(observations.compatibility.body).instanceId !==
      object(observations.canonical.body).instanceId
  )
    errors.push('同一新平台的两个入口不能生成不同实例身份')
  return {
    equivalent:
      !errors.length && stable(old.value) === stable(compatibility.value),
    ingressEquivalent:
      !errors.length && stable(compatibility.value) === stable(canonical.value),
    rules: [
      ...new Set([...old.rules, ...compatibility.rules, ...canonical.rules]),
    ],
    errors,
  }
}
