import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot, appRoot } from '../../scripts/paths.ts'

const baselineRoot = resolve(appRoot, 'tests/fixtures/baselines')
const digest = (value) => createHash('sha256').update(value).digest('hex')

/** 读取工作区真实文件，包括未提交源文件与删除状态；不读取缓存和凭据。 */
export async function sourceFingerprint() {
  const listing = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'apps/admin',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  const files = [...new Set(listing.split('\0').filter(Boolean))].sort()
  const records = []
  for (const file of files) {
    if (
      /(?:^|\/)(?:node_modules|\.next[^/]*|out|\.office-fonts|__pycache__)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/u.test(
        file,
      )
    )
      continue
    const absolute = resolve(repositoryRoot, file)
    records.push({
      path: file,
      sha256: existsSync(absolute) ? digest(await readFile(absolute)) : null,
    })
  }
  return records
}

/** 固定当前工作区的接口和来源，不启动数据库、旧平台或执行引擎。 */
export async function captureBaseline() {
  await mkdir(baselineRoot, { recursive: true })
  const output = async (name, value) =>
    writeFile(
      resolve(baselineRoot, name),
      `${JSON.stringify(value, null, 2)}\n`,
    )
  const fingerprint = await sourceFingerprint()
  await output('source-fingerprint.json', {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
    capturedAt: new Date().toISOString(),
    fingerprint: digest(JSON.stringify(fingerprint)),
    files: fingerprint,
  })
  const { createApplication } = await import(
    pathToFileURL(resolve(repositoryRoot, 'apps/admin/server/application.ts'))
      .href
  )
  const { permissions, memberPermissions } = await import(
    pathToFileURL(
      resolve(repositoryRoot, 'apps/admin/server/identity/permissions.ts'),
    ).href
  )
  const database = {
    async query() {
      return []
    },
    async transaction(operation) {
      return operation(this)
    },
    async lease() {
      return null
    },
    async close() {},
  }
  const application = createApplication({
    configuration: {
      secret: 'synthetic-baseline-only',
      encryptionKey: Buffer.alloc(32, 1).toString('base64url'),
      filesDirectory: 'unused',
      dataDirectory: 'unused',
      origins: [],
      databaseUrl: 'postgres://unused/unused',
    },
    database,
    redis: {
      async take() {
        return true
      },
    },
    log() {},
  })
  try {
    const routes = [
      ...application.router.routes.map(({ method, path }) => ({
        method,
        path,
        transport: 'http',
      })),
      ...application.websocketPaths.map((path) => ({
        method: 'GET',
        path,
        transport: 'websocket',
      })),
    ]
    await output('routes.json', routes)
    await output('permissions.json', { permissions, memberPermissions })
    const source = await readFile(
      resolve(repositoryRoot, 'apps/admin/src/features/console/modules.ts'),
      'utf8',
    )
    const modules = [
      ...source.matchAll(
        /id: '([^']+)',\s+route: '([^']+)',\s+title: '([^']+)',\s+englishTitle: '([^']+)',\s+icon: '([^']+)',\s+permissions: (\[[^\]]*\])/gu,
      ),
    ].map((m) => ({
      id: m[1],
      route: m[2],
      title: m[3],
      englishTitle: m[4],
      icon: m[5],
      permissions: [...m[6].matchAll(/'([^']+)'/gu)].map((p) => p[1]),
    }))
    if (!modules.length) throw new Error('模块目录解析为空，拒绝生成空基线')
    await output('modules.json', modules)
    const contractPaths = [
      'apps/admin/server/contracts/openapi-v2.json',
      'apps/admin/server/identity/routes.ts',
      'apps/admin/server/identity/oauth.ts',
      'apps/admin/server/agents/contracts.ts',
      'apps/admin/server/agents/resource-contracts.ts',
      'apps/admin/server/skills/definitions.ts',
      'apps/desktop/core/src/contracts/skills.ts',
      'apps/desktop/core/src/contracts/extensions.ts',
      'docs/agent-extension-development.md',
    ]
    const contracts = []
    for (const path of contractPaths) {
      if (!existsSync(resolve(repositoryRoot, path))) continue
      const content = await readFile(resolve(repositoryRoot, path))
      contracts.push({ path, sha256: digest(content) })
    }
    await output('contract-sources.json', contracts)
    await writeFile(
      resolve(baselineRoot, 'legacy-openapi.json'),
      await readFile(
        resolve(repositoryRoot, 'apps/admin/server/contracts/openapi-v2.json'),
      ),
    )
    console.log(
      `已冻结 ${fingerprint.length} 个源码指纹、${routes.length} 个入口、${modules.length} 个页面模块`,
    )
  } finally {
    await application.service.close()
  }
}

/** 只比较，不修复或回退旧包；用户后续变更必须显式更新基准。 */
export async function verifyBaseline() {
  const baseline = JSON.parse(
    await readFile(resolve(baselineRoot, 'source-fingerprint.json'), 'utf8'),
  )
  const current = await sourceFingerprint()
  const previous = new Map(
    baseline.files.map((entry) => [entry.path, entry.sha256]),
  )
  const observed = new Map(current.map((entry) => [entry.path, entry.sha256]))
  const changed = [...new Set([...previous.keys(), ...observed.keys()])].filter(
    (path) => previous.get(path) !== observed.get(path),
  )
  if (changed.length)
    throw new Error(
      `旧管理端与冻结基线不同，请核对修改归属：\n${changed.join('\n')}`,
    )
  console.log(`旧 apps/admin 保护检查通过：${current.length} 个文件未变`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === 'capture') await captureBaseline()
  else if (process.argv[2] === 'verify') await verifyBaseline()
  else throw new Error('用法：baseline.mjs capture|verify')
}
