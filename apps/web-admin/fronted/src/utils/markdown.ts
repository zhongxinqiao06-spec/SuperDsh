/** Markdown 只生成文本节点描述，不接收 HTML、脚本链接或远程图片。 */
export interface MarkdownInline {
  kind: 'text' | 'strong' | 'em' | 'code' | 'link'
  text: string
  href?: string
}
export interface MarkdownBlock {
  kind: 'paragraph' | 'heading' | 'quote' | 'list' | 'code'
  level?: number
  text: string
  tokens: MarkdownInline[]
}
export function markdownInline(value: string): MarkdownInline[] {
  const pattern =
    /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/gu
  const result: MarkdownInline[] = []
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset)
      result.push({ kind: 'text', text: value.slice(offset, match.index) })
    if (match[1] && match[2]) {
      let href: string | undefined
      try {
        const url = new URL(match[2])
        if (['https:', 'http:', 'mailto:'].includes(url.protocol))
          href = url.href
      } catch {
        /* 非完整安全地址保持纯文本。 */
      }
      result.push(
        href
          ? { kind: 'link', text: match[1], href }
          : { kind: 'text', text: match[0] },
      )
    } else
      result.push({
        kind: match[3] ? 'strong' : match[4] ? 'code' : 'em',
        text: match[3] ?? match[4] ?? match[5] ?? '',
      })
    offset = match.index + match[0].length
  }
  if (offset < value.length)
    result.push({ kind: 'text', text: value.slice(offset) })
  return result
}
export function markdownBlocks(value: string): MarkdownBlock[] {
  const result: MarkdownBlock[] = []
  let fence: string[] | null = null
  for (const line of value.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('```')) {
      if (fence) {
        result.push({ kind: 'code', text: fence.join('\n'), tokens: [] })
        fence = null
      } else fence = []
      continue
    }
    if (fence) {
      fence.push(line)
      continue
    }
    if (!line.trim()) continue
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line),
      list = /^\s*(?:[-*+] |\d+\. )(.+)$/u.exec(line),
      quote = /^>\s?(.*)$/u.exec(line)
    const text = heading?.[2] ?? list?.[1] ?? quote?.[1] ?? line
    result.push({
      kind: heading ? 'heading' : list ? 'list' : quote ? 'quote' : 'paragraph',
      level: heading?.[1]?.length,
      text,
      tokens: markdownInline(text),
    })
  }
  if (fence) result.push({ kind: 'code', text: fence.join('\n'), tokens: [] })
  return result
}
