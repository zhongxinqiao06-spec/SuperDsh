import { createUuid } from '@/utils/uuid'
import DOMPurify from 'dompurify'

let engine: Promise<(typeof import('mermaid'))['default']> | undefined
/** 图表使用固定严格配置；不绑定图表中的点击处理或加载外部资源。 */
export async function renderDiagram(
  source: string,
  container: HTMLElement,
): Promise<string> {
  if (source.length > 50000) throw new Error('图表过大，请下载源文件查看')
  // 模型文本不能改写 Mermaid 全局配置或通过样式发起远端资源请求。
  if (
    /^\s*---|%%\s*\{|@import|url\s*\(|(?:https?|javascript|data|file):/imu.test(
      source,
    )
  )
    throw new Error('图表含有不受支持的外部配置或资源')
  engine ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50000,
      theme: 'neutral',
      flowchart: { htmlLabels: false },
    })
    return mermaid
  })
  const mermaid = await engine
  const result = await mermaid.render(
    `diagram-${createUuid()}`,
    source,
    container,
  )
  const safe = DOMPurify.sanitize(result.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe'],
  })
  const document = new DOMParser().parseFromString(safe, 'image/svg+xml')
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (
        (attribute.localName === 'href' && !attribute.value.startsWith('#')) ||
        (attribute.localName === 'style' &&
          /@import|url\(\s*['"]?(?!#)/iu.test(attribute.value))
      )
        element.removeAttribute(attribute.name)
    }
    if (element.localName === 'style')
      element.textContent = (element.textContent ?? '')
        .replace(/@import[^;]+;/giu, '')
        .replace(/url\(\s*['"]?(?!#)[^)]+\)/giu, 'none')
  }
  return new XMLSerializer().serializeToString(document.documentElement)
}
