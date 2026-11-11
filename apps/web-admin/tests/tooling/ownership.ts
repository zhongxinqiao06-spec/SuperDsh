import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { appRoot, repositoryRoot } from '../../scripts/paths.ts'

/** 生产树的版本、语言和测试边界；纯元数据/冻结协议另有明确归属。 */
export function inspectSource(path: string, source: string): string[] {
  const errors: string[] = []
  if (
    /(?:^|\/)(?:__tests__|fixtures|mocks|coverage|test-results)(?:\/|$)|\.(?:test|spec)\./u.test(
      path,
    )
  )
    errors.push('测试或过程文件混入生产目录')
  if (path.startsWith('backend/app/') && /\.[cm]?[jt]sx?$/u.test(path))
    errors.push('后端业务目录只允许 Python 源码')
  if (
    path.startsWith('fronted/src/') &&
    /(?:from\s+|import\s*\()["'][^"']*(?:backend|apps\/admin|node:)/u.test(
      source,
    )
  )
    errors.push('浏览器导入后端、旧实现或 Node')
  if (
    /\.(?:py|ts|vue)$/u.test(path) &&
    /["'`]\/(?:api|ws)\/v\d+(?:\/|["'`])/u.test(source)
  )
    errors.push('业务代码硬编码版本路由')
  if (
    /\.(?:py|ts|vue)$/u.test(path) &&
    /(?:releaseVersion|appVersion|version)\s*[:=]\s*["']\d+\.\d+\.\d+/u.test(
      source,
    )
  )
    errors.push('业务代码硬编码发布版本')
  if (
    /\.(?:ts|vue)$/u.test(path) &&
    /@ts-nocheck|:\s*any\b|\bas\s+any\b/u.test(source)
  )
    errors.push('宽泛类型绕过')
  if (/(?:from|import|require)[^\n]*apps[/]admin/u.test(source))
    errors.push('生产依赖旧管理端')
  return errors
}

async function files(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await files(path)))
    else output.push(path)
  }
  return output
}

/** 自动门禁不修改源码；违规必须在所属模块修复，不能靠扫描排除通过。 */
export async function verifyOwnership() {
  const errors: string[] = []
  const production = [
    'fronted/src',
    'backend/app',
    'backend/toolkits',
    'backend/resources',
    'contracts',
    'engine-adapter/src',
    'scripts',
  ]
  for (const directory of production)
    for (const file of await files(resolve(appRoot, directory))) {
      const path = relative(appRoot, file).replaceAll('\\', '/')
      if (/\.(?:py|ts|js|mjs|vue|json)$/u.test(path)) {
        for (const issue of inspectSource(path, await readFile(file, 'utf8')))
          errors.push(`${path}: ${issue}`)
      }
      if (
        /__pycache__|\.pyc$|\.log$|\.sqlite(?:3)?$|\.db$|\.egg-info/u.test(path)
      )
        errors.push(`${path}: 过程产物在生产树`)
    }
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  )
  if (
    packageJson.workspaces.some((value: string) =>
      value.startsWith('apps/web-admin'),
    )
  )
    errors.push('新前端不能加入旧 Docker 未复制 manifest 的 workspace 集合')
  const frontedManifest = resolve(appRoot, 'fronted/package.json')
  if (existsSync(frontedManifest)) {
    const fronted: Record<string, unknown> = JSON.parse(
      await readFile(frontedManifest, 'utf8'),
    )
    // npm run 只提供目录内的命令入口；依赖与发布版本继续由根工程统一管理。
    if (
      fronted.private !== true ||
      fronted.type !== 'module' ||
      Object.keys(fronted).some(
        (key) => !['private', 'type', 'scripts'].includes(key),
      )
    )
      errors.push(
        '新前端 manifest 仅允许 private、type 和 scripts，不声明独立依赖或版本',
      )
  }
  for (const lock of [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ])
    if (existsSync(resolve(appRoot, 'fronted', lock)))
      errors.push(`新前端依赖沿用根 Yarn 锁文件，不建立 ${lock}`)
  for (const root of ['fronted/tests', 'backend/tests'])
    if (existsSync(resolve(appRoot, root)))
      errors.push(`测试应集中，发现 ${root}`)
  // 入口旁的构建元数据也属于过程产物，不能只检查 app 子目录。
  for (const entry of await readdir(resolve(appRoot, 'backend')))
    if (
      entry.endsWith('.egg-info') ||
      [
        '__pycache__',
        '.pytest_cache',
        '.ruff_cache',
        '.mypy_cache',
        'build',
      ].includes(entry)
    )
      errors.push(`backend/${entry}: 过程产物应放在 .superdsh-work`)
  for (const dockerfile of ['fronted', 'backend']) {
    const content = await readFile(
      resolve(appRoot, `deployment/Dockerfile.${dockerfile}`),
      'utf8',
    )
    if (/COPY\s+(?:\.\s|apps\/admin\/(?!package\.json))/u.test(content))
      errors.push(`Dockerfile.${dockerfile} 复制了未限定源码或旧业务`)
    const ignore = await readFile(
      resolve(appRoot, `deployment/Dockerfile.${dockerfile}.dockerignore`),
      'utf8',
    )
    for (const pattern of [
      '.superdsh',
      '.superdsh-work',
      '**/tests',
      '**/__pycache__',
      'apps/web-admin/backend/config/**',
      '!apps/web-admin/backend/config/model-defaults.example.json',
    ])
      if (!ignore.includes(pattern))
        errors.push(`Dockerfile.${dockerfile} 缺少排除 ${pattern}`)
    if (!ignore.split(/\r?\n/u).includes('**'))
      errors.push(
        `Dockerfile.${dockerfile} 应先拒绝全部上下文，再按构建输入放行`,
      )
  }
  const gitignore = await readFile(
    resolve(repositoryRoot, '.gitignore'),
    'utf8',
  )
  if (
    !gitignore
      .split(/\r?\n/u)
      .includes('apps/web-admin/backend/config/model-defaults.json')
  )
    errors.push('后端真实模型配置必须排除 Git，仅提交无凭据模板')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('新管理端语言、版本、目录和镜像所有权检查通过')
}
