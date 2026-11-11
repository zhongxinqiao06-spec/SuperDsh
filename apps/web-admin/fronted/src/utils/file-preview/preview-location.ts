import type { LocationQuery } from 'vue-router'
import type { PreviewLocation } from '@/types/file-preview/preview'

/** 显示定位参数只影响选区，不拼接后端路径或改变访问令牌。 */
export function previewLocation(query: LocationQuery): PreviewLocation {
  const text = (key: string) =>
    typeof query[key] === 'string' ? query[key] : ''
  const positive = (key: string) =>
    Math.max(1, Math.min(1_000_000, Number.parseInt(text(key), 10) || 1))
  return {
    connectorId: text('connectorId'),
    root: text('root'),
    path: text('path'),
    name: text('name'),
    previewToken: text('previewToken'),
    sourceUrl: text('sourceUrl'),
    mediaType: text('mediaType'),
    line: positive('line'),
    column: positive('column'),
  }
}

/** 不把任意 sourceUrl 当作带登录凭据的跳板；共享链接也必须由当前平台提供。 */
export function previewSourceUrl(source: string, origin: string): string {
  const url = new URL(source, origin)
  if (
    url.origin !== origin ||
    !url.pathname.startsWith('/api/') ||
    url.username ||
    url.password
  )
    throw new Error('预览来源必须是当前平台的文件地址')
  return url.href
}

/** UTF-16 选区与浏览器 textarea 一致；越界行列收敛到文件末尾。 */
export function previewCaret(
  content: string,
  line: number,
  column: number,
): number {
  const lines = content.split('\n')
  const index = Math.min(lines.length - 1, Math.max(0, line - 1))
  const prefix = lines
    .slice(0, index)
    .reduce((total, value) => total + value.length + 1, 0)
  return prefix + Math.min(lines[index]?.length ?? 0, Math.max(0, column - 1))
}

/** 代码和主动文档仅按纯文本显示，不把 HTML/SVG 当作可执行页面嵌入。 */
export function isPreviewText(mediaType: string, name: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    [
      'application/json',
      'application/javascript',
      'application/xml',
      'application/yaml',
    ].includes(mediaType) ||
    /\.(?:txt|md|markdown|csv|json|js|ts|tsx|jsx|py|yaml|yml|xml|html|css|log|sql|ini|sh|toml|rs|go|java)$/iu.test(
      name,
    )
  )
}
