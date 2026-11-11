import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/utils/markdown-renderer'
import { renderDiagram } from '@/utils/diagram-renderer'

describe('通用富文本安全渲染', () => {
  it('保留表格、公式和语法高亮，将图表拆为独立异步片段', () => {
    const values = renderMarkdown(
      '| 名称 | 数值 |\n| --- | --- |\n| 收入 | 12 |\n\n$x^2$\n\n```typescript\nconst value = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```',
    )
    expect(values[0]?.content).toContain('<table>')
    expect(values[0]?.content).toContain('katex')
    expect(values[0]?.content).toContain('hljs-keyword')
    expect(values[1]).toEqual({ kind: 'diagram', content: 'graph TD; A-->B' })
  })
  it('HTML、脚本链接、公式宏与远程图片不能产生主动内容', async () => {
    const values = renderMarkdown(
      '<img src="https://external.invalid/image" onerror="alert(1)">\n\n[攻击](javascript:alert%281%29)\n\n$\\href{javascript:alert(1)}{点击}$',
    )
    const root = document.createElement('div')
    root.innerHTML = values.map((item) => item.content).join('')
    expect(
      root.querySelector('img,script,iframe,[onerror],a[href^="javascript:"]'),
    ).toBeNull()
    await expect(
      renderDiagram(
        '%%{init: {securityLevel:"loose"}}%%\ngraph TD; A-->B',
        root,
      ),
    ).rejects.toThrow('外部配置')
    await expect(
      renderDiagram(
        'graph TD\nclassDef x fill:url(https://external.invalid/a)',
        root,
      ),
    ).rejects.toThrow('外部配置')
  })
})
