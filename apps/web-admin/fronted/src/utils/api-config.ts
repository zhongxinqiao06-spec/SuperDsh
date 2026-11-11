/** 统一构造规范入口；领域调用只传相对资源路径，禁止外部 URL 携带凭据。 */
export function apiUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error('API 路径必须为站内相对资源路径')
  }
  const base = import.meta.env.VITE_WEB_ADMIN_API_BASE ?? '/api'
  const url = new URL(
    `${base.replace(/\/$/, '')}${path}`,
    window.location.origin,
  )
  if (url.origin !== window.location.origin)
    throw new Error('API 必须使用同源入口')
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}`
}

/** WS 使用独立集中入口；票据通过参数编码，不接受任意外部地址。 */
export function socketUrl(path: string, ticket: string): string {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error('无效的订阅路径')
  const url = new URL(`/ws${path}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}
