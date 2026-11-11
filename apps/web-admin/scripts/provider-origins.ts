/** 显式信任的供应商 origin；只放行精确来源，不支持通配符、凭据或接口路径。 */
export function providerAllowedOrigins(value: unknown = []): string[] {
  if (!Array.isArray(value))
    throw new Error('providerAllowedOrigins 必须为 origin 字符串数组')
  const origins = value.map((entry: unknown) => {
    if (
      typeof entry !== 'string' ||
      entry !== entry.trim() ||
      !/^https?:\/\/[^/?#\\\s,]+$/iu.test(entry) ||
      entry.includes('@') ||
      entry.includes('*')
    )
      throw new Error(
        'providerAllowedOrigins 只能包含无凭据、路径、查询参数或通配符的 HTTP/HTTPS origin',
      )
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      throw new Error('providerAllowedOrigins 包含无效的绝对 origin')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.hostname.includes('*') ||
      url.hostname.includes(',') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('providerAllowedOrigins 包含无效的绝对 origin')
    return url.origin
  })
  return [...new Set(origins)]
}

/** 显式环境变量优先；空字符串可关闭放行，未设置时使用配置，非法配置仍拒绝启动。 */
export function providerOriginsEnvironment(
  value: unknown,
  override?: string,
): string {
  const configured = providerAllowedOrigins(value)
  const selected =
    override === undefined
      ? configured
      : providerAllowedOrigins(
          override.trim() === ''
            ? []
            : override.split(',').map((entry) => entry.trim()),
        )
  return selected.join(',')
}
