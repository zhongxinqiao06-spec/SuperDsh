import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'

const reports = [
  'pytest-junit.xml',
  'dsh-evidence.json',
  'fronted-tests.json',
  'commands/results.json',
  'live-browser/browser-results.json',
] as const

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return (
    Boolean(child) &&
    !isAbsolute(child) &&
    child !== '..' &&
    !child.startsWith('..' + sep)
  )
}

/** 仅报告文本可归档；已知环境凭据及常见令牌形式统一移除，保留失败断言和业务观察。 */
export function redactCheckReport(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  let result = value
  for (const [name, secret] of Object.entries(environment)) {
    if (
      !secret ||
      secret.length < 4 ||
      !/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/u.test(name)
    )
      continue
    const escaped = secret
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
    for (const candidate of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      escaped,
    ])
      result = result.replaceAll(candidate, '[redacted]')
  }
  return result
    .replace(/(Bearer\s+)[^\s"'<>\\]+/giu, '$1[redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      '[redacted]',
    )
    .replace(
      /([?&](?:ticket|token|accessToken|previewToken|previewAccessToken)=)[^&\s"'<>\\]+/giu,
      '$1[redacted]',
    )
    .replace(
      /("(?:accessToken|refreshToken|connectorToken|setupToken|apiKey|password|secret|token|ticket)"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      '$1"[redacted]"',
    )
}

interface CheckCompletion {
  directory: string
  environment: NodeJS.ProcessEnv
  checksPassed: boolean
  checkError?: unknown
  cleanup: () => Promise<void>
  verify: () => Promise<void>
}

/** 清理前只保存五类白名单报告；归档/校验失败也必须回收本轮库、容器和Home。 */
export async function finishCheckRun(input: CheckCompletion): Promise<string> {
  const root = resolve(repositoryRoot, '.superdsh-work/web-admin-validation')
  const source = resolve(input.directory)
  const destination = resolve(
    root,
    `check-report-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
  const errors: string[] = []
  const files: string[] = [],
    missing: string[] = []
  let archiveCreated = false,
    archivePassed = true,
    cleanupPassed = false,
    integrityPassed = false
  const errorText = (error: unknown) =>
    redactCheckReport(
      error instanceof Error ? error.message : String(error),
      input.environment,
    )
  if (input.checkError !== undefined) errors.push(errorText(input.checkError))
  try {
    if (!inside(root, source)) throw new Error('拒绝归档验证目录以外的数据')
    const actualSource = await realpath(source)
    if (!inside(await realpath(root), actualSource))
      throw new Error('验证来源目录指向外部路径')
    await mkdir(destination)
    archiveCreated = true
    for (const name of reports) {
      try {
        const candidate = resolve(source, name)
        const metadata = await lstat(candidate)
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          !inside(actualSource, await realpath(candidate)) ||
          metadata.size > 64 * 1024 * 1024
        )
          throw new Error(`拒绝归档无效报告 ${name}`)
        const data = redactCheckReport(
          await readFile(candidate, 'utf8'),
          input.environment,
        )
        const target = resolve(destination, name)
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, data, { flag: 'wx' })
        files.push(name)
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          missing.push(name)
        else {
          archivePassed = false
          errors.push(errorText(error))
        }
      }
    }
    if (input.checksPassed && missing.length) {
      archivePassed = false
      errors.push(`检查声称完成但缺少必要报告：${missing.join(', ')}`)
    }
  } catch (error) {
    archivePassed = false
    errors.push(errorText(error))
  } finally {
    try {
      await input.cleanup()
      cleanupPassed = true
    } catch (error) {
      errors.push(errorText(error))
    }
    try {
      await input.verify()
      integrityPassed = true
    } catch (error) {
      errors.push(errorText(error))
    }
  }
  if (archiveCreated) {
    await writeFile(
      resolve(destination, 'summary.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceRun: relative(root, source),
          scope:
            'single-application-full-check-with-controlled-engine-and-browser',
          fullParity: false,
          checksPassed: input.checksPassed,
          fullCheckPassed:
            input.checksPassed &&
            archivePassed &&
            integrityPassed &&
            cleanupPassed,
          cleanupPassed,
          archivePassed,
          integrityPassed,
          files,
          missing,
          errors,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`完整检查证据：${destination}`)
  }
  if (
    errors.length ||
    !input.checksPassed ||
    !cleanupPassed ||
    !archivePassed ||
    !integrityPassed
  )
    throw Object.assign(
      new Error(`完整检查或收尾失败：${errors.join('；') || '检查未完成'}`),
      { reportDirectory: archiveCreated ? destination : null },
    )
  return destination
}
