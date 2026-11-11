import { createHash } from 'node:crypto'

export interface Observation {
  status: number
  mediaType: string | null
  body: unknown
}
export interface Comparison {
  id: string
  method: string
  legacyPath: string
  canonicalPath: string
  old: Observation
  compatibility: Observation
  canonical: Observation
  equal: boolean
  ingressEqual: boolean
}

/** 测试输出不保存访问令牌、刷新凭据或 API key；其存在性仍参与比较。 */
export function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:accessToken|refreshToken|connectorToken|setupToken|apiKey|password|secret|token|ticket)$/iu.test(
          key,
        )
          ? typeof item === 'string'
            ? '<present-string>'
            : item
          : redacted(item),
      ]),
    )
  return value
}

/** 相同字段和值才判等；不删除错误、空值、分页、顺序或新增字段来掩盖差异。 */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** 有界 HTTP 请求，二进制只记录摘要；禁止跟随 OAuth 重定向到外部服务。 */
export async function observe(
  base: string,
  path: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<Observation> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SuperDsh-Agent-Preparation': 'deferred',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const mediaType = response.headers.get('content-type')?.split(';')[0] ?? null
  let content: unknown = null
  if (bytes.length) {
    if (mediaType === 'application/json')
      content = JSON.parse(bytes.toString()) as unknown
    else
      content = {
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
  }
  return { status: response.status, mediaType, body: content }
}
