/** 契约投影只消除说明文字与字段顺序；校验约束、状态码和媒体类型仍参与差异。 */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 入口参数名称可变化；单段参数不能吞掉层级，多段参数只能位于末段。 */
export function templateMatches(template: string, candidate: string): boolean {
  const parts = template.split(/(\{[A-Za-z_]\w*(?::path)?\})/u)
  const expression = parts
    .map((part) => {
      if (/^\{[A-Za-z_]\w*:path\}$/u.test(part)) return '.+'
      if (/^\{[A-Za-z_]\w*\}$/u.test(part)) return '[^/]+'
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    })
    .join('')
  return new RegExp(`^${expression}/?$`, 'u').test(candidate)
}

/** 展开本地引用且记录循环边界；缺引用不能被当作空 Schema 消失。 */
export function contractProjection(
  value: unknown,
  document: unknown,
  seen = new Set<string>(),
  depth = 0,
): unknown {
  if (depth > 20) return { $depthLimit: true }
  if (Array.isArray(value))
    return value.map((item) =>
      contractProjection(item, document, seen, depth + 1),
    )
  if (!value || typeof value !== 'object') return value
  const object = record(value)
  if (typeof object.$ref === 'string' && object.$ref.startsWith('#/')) {
    if (seen.has(object.$ref))
      return { $recursive: object.$ref.split('/').at(-1) }
    let target: unknown = document
    for (const part of object.$ref.slice(2).split('/'))
      target = record(target)[part.replaceAll('~1', '/').replaceAll('~0', '~')]
    if (target === undefined) return { $missing: object.$ref }
    const visited = new Set(seen).add(object.$ref)
    return contractProjection(
      {
        ...record(target),
        ...Object.fromEntries(
          Object.entries(object).filter(([key]) => key !== '$ref'),
        ),
      },
      document,
      visited,
      depth + 1,
    )
  }
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter(
        (key) =>
          ![
            'title',
            'description',
            'example',
            'examples',
            'summary',
            'operationId',
            'tags',
          ].includes(key),
      )
      .map((key) => [
        key,
        contractProjection(object[key], document, seen, depth + 1),
      ]),
  )
}

/** 测试引用仅用于导航，不读取上次成功状态或凭源码存在伪造执行通过。 */
export function indexedEvidence(cases: string[]): {
  status: 'indexed-only'
  cases: string[]
  executed: false
} {
  return { status: 'indexed-only', cases, executed: false }
}
