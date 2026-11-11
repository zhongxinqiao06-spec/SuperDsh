import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import hljs from 'highlight.js/lib/common'

/** Markdown 文档片段；图表单独交给异步组件，普通 HTML 统一净化。 */
export interface MarkdownFragment {
  kind: 'html' | 'diagram'
  content: string
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
function formula(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: 'warn',
      maxExpand: 1000,
      maxSize: 20,
    })
  } catch {
    return `<code>${escape(value)}</code>`
  }
}
const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(`[${text}]`),
    link: function ({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      try {
        const url = new URL(href)
        if (['https:', 'http:', 'mailto:'].includes(url.protocol))
          return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      } catch {
        /* 非完整地址只展示文字，不能隐式访问本机资源。 */
      }
      return label
    },
    code: ({ text, lang }) => {
      if (lang === 'math' || lang === 'latex') return formula(text, true)
      const language = lang?.split(/\s/u)[0] ?? ''
      const highlighted =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escape(text)
      return `<pre><code class="hljs">${highlighted}</code></pre>`
    },
  },
})
parser.use({
  extensions: [
    {
      name: 'displayMath',
      level: 'block',
      start: (source) => source.indexOf('$$'),
      tokenizer: (source) => {
        const value = /^\$\$\s*\n?([\s\S]+?)\n?\$\$(?:\n|$)/u.exec(source)
        return value
          ? { type: 'displayMath', raw: value[0], text: value[1] ?? '' }
          : undefined
      },
      renderer: (token) => formula(String(token.text), true),
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start: (source) => source.indexOf('$'),
      tokenizer: (source) => {
        const value = /^\$([^$\n]+?)\$(?!\d)/u.exec(source)
        return value
          ? { type: 'inlineMath', raw: value[0], text: value[1] ?? '' }
          : undefined
      },
      renderer: (token) => formula(String(token.text), false),
    },
  ],
})

/** 原始 HTML 不执行；Markdown 链接、公式宏、代码高亮均受固定策略限制。 */
export function renderMarkdown(source: string): MarkdownFragment[] {
  const result: MarkdownFragment[] = []
  let chunk = ''
  const flush = () => {
    if (!chunk) return
    result.push({
      kind: 'html',
      content: DOMPurify.sanitize(
        String(parser.parse(chunk, { async: false })),
        {
          USE_PROFILES: { html: true, mathMl: true },
          ADD_ATTR: ['target'],
          FORBID_TAGS: ['script', 'iframe', 'form', 'style'],
        },
      ),
    })
    chunk = ''
  }
  for (const token of parser.lexer(source)) {
    if (token.type === 'code' && token.lang === 'mermaid') {
      flush()
      result.push({ kind: 'diagram', content: token.text })
    } else chunk += token.raw
  }
  flush()
  return result
}
