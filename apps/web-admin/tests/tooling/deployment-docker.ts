/** 部署自测的 Docker 资源边界：仅清理本轮双标签对象，不依赖默认项目。 */
import { spawn } from 'node:child_process'
import { repositoryRoot } from '../../scripts/paths.ts'

export const validationLabel = 'superdsh.validation'

/** 有界执行 Docker；错误只报告步骤和退出码，避免将配置及凭据写入日志。 */
export async function docker(args: string[], step: string, timeout = 120_000) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error(`${step}: Docker 超时`)
      child.kill()
    }, timeout)
    child.stdout.setEncoding('utf8').on('data', (value: string) => {
      output += value
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error(`${step}: Docker 输出超出限制`)
        child.kill()
      }
    })
    child.stderr.resume()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${step}: Docker 启动失败`, { cause: error }))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0)
        reject(failure ?? new Error(`${step}: Docker 退出码 ${code}`))
      else resolve(output.trim())
    })
  })
}

/** 验证 JSON 对象形状；Docker/HTTP 输入不以宽泛类型断言跳过检查。 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('部署验证收到非对象响应')
  return value as Record<string, unknown>
}

/** Docker inspect 只允许单一目标，避免错误选择整个项目之外的资源。 */
export async function inspect(
  kind: 'container' | 'volume' | 'network',
  id: string,
) {
  const parsed: unknown = JSON.parse(
    await docker([kind, 'inspect', id], `检查 ${kind} 归属`),
  )
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new Error(`无法确认 ${kind} 唯一归属`)
  return object(parsed[0])
}

/** 列出指定项目对象；未使用名称前缀猜测归属。 */
export async function resources(
  kind: 'container' | 'volume' | 'network',
  project: string,
) {
  const args = kind === 'container' ? ['container', 'ls', '-a'] : [kind, 'ls']
  const result = await docker(
    [...args, '--filter', `label=com.docker.compose.project=${project}`, '-q'],
    `枚举本轮 ${kind}`,
  )
  return result ? result.split(/\r?\n/u) : []
}

/** 清理前逐项核验项目标签与本轮标签；任一冲突都会拒绝删除全部资源。 */
export async function assertOwned(project: string, runId: string) {
  for (const kind of ['container', 'volume', 'network'] as const) {
    for (const id of await resources(kind, project)) {
      const item = await inspect(kind, id)
      const labels = object(
        kind === 'container' ? object(item.Config).Labels : item.Labels,
      )
      if (
        labels['com.docker.compose.project'] !== project ||
        labels[validationLabel] !== runId
      )
        throw new Error(`拒绝清理归属不明的 ${kind}`)
    }
  }
}
