import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { documentFont, officeFontDirectory } from './font-metrics.ts'
import { OfficeInputError } from './types.ts'
import {
  presentationThemes,
  validatePresentationTheme,
  type PresentationDesignTheme,
} from './design-themes.ts'

type Node = {
  id: string
  title: string
  detail?: string
  value?: string
  parentId?: string
}
export interface IllustrationPlan {
  title: string
  purpose?: string
  layout: 'flow' | 'timeline' | 'organization' | 'compare' | 'metrics'
  nodes: Node[]
  designTheme: PresentationDesignTheme
}
function fail(message: string): never {
  throw new OfficeInputError(message)
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('配图方案必须为 JSON 对象')
const text = (value: unknown, label: string, max: number) =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)
    ? value.trim()
    : fail(`${label}不能为空且最多 ${max} 字`)

export function validateIllustration(value: unknown): IllustrationPlan {
  const input = record(value)
  if (
    Object.keys(input).some(
      (key) =>
        !['title', 'purpose', 'layout', 'nodes', 'designTheme'].includes(key),
    )
  )
    fail('配图方案包含不支持字段；不能提交 SVG、脚本、路径或外部图片地址')
  if (
    !['flow', 'timeline', 'organization', 'compare', 'metrics'].includes(
      String(input.layout),
    )
  )
    fail('配图布局不支持')
  if (
    !Array.isArray(input.nodes) ||
    input.nodes.length < 2 ||
    input.nodes.length > 9
  )
    fail('每张配图需要 2–9 个节点，请将复杂内容拆图')
  const nodes = input.nodes.map((raw) => {
    const item = record(raw)
    if (
      Object.keys(item).some(
        (key) => !['id', 'title', 'detail', 'value', 'parentId'].includes(key),
      )
    )
      fail('配图节点不支持此字段')
    return {
      id: text(item.id, '节点标识', 60),
      title: text(item.title, '节点标题', 45),
      ...(item.detail === undefined
        ? {}
        : { detail: text(item.detail, '节点说明', 220) }),
      ...(item.value === undefined
        ? {}
        : { value: text(item.value, '指标', 24) }),
      ...(item.parentId === undefined
        ? {}
        : { parentId: text(item.parentId, '上级节点', 60) }),
    }
  })
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) fail('节点标识不能重复')
  if (
    nodes.some(
      (node) =>
        node.parentId &&
        (!ids.has(node.parentId) || input.layout !== 'organization'),
    )
  )
    fail('上级节点不存在或不是组织关系图')
  if (input.layout === 'organization') {
    if (nodes.filter((node) => !node.parentId).length !== 1)
      fail('组织关系图需要一个根节点')
    for (const node of nodes) {
      const seen = new Set<string>()
      let cursor: Node | undefined = node
      while (cursor) {
        if (seen.has(cursor.id)) fail('组织关系不能循环')
        seen.add(cursor.id)
        cursor = nodes.find((candidate) => candidate.id === cursor!.parentId)
      }
      if (seen.size > 3) fail('单图最多三层组织关系，请拆图展示')
    }
  }
  if (input.layout === 'metrics' && nodes.some((node) => !node.value))
    fail('指标图需要明确的数值；请从来源读取，不能自动补数')
  return {
    title: text(input.title, '配图标题', 100),
    ...(input.purpose === undefined
      ? {}
      : { purpose: text(input.purpose, '配图用途', 300) }),
    layout: input.layout as IllustrationPlan['layout'],
    nodes,
    designTheme: validatePresentationTheme(
      input.designTheme ?? presentationThemes[0],
    ),
  }
}

type Box = { x: number; y: number; w: number; h: number; node: Node }
const escape = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  )
const fontFamily = 'Noto Sans CJK SC'
function textLines(value: string, width: number, size: number) {
  const font = documentFont()
  if (!font) fail('配图字体尚未准备，请运行 server:sync 后重试')
  const lines: string[] = []
  for (const paragraph of value.split('\n')) {
    let line = '',
      advance = 0
    for (const character of Array.from(paragraph)) {
      const delta =
        (font
          .layout(character)
          .positions.reduce((sum, item) => sum + item.xAdvance, 0) /
          font.unitsPerEm) *
        size
      if (advance && advance + delta > width) {
        lines.push(line)
        line = ''
        advance = 0
      }
      line += character
      advance += delta
    }
    lines.push(line)
  }
  return lines
}

/** Model supplies content only. Fixed layout, glyph measurement and escaped SVG determine pixels. */
export function illustrationSvg(plan: IllustrationPlan): string {
  const t = plan.designTheme,
    width = 1600,
    height = 900
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="1600" height="900" fill="#${t.background}"/><rect x="72" y="65" width="60" height="7" rx="3" fill="#${t.accent}"/>`,
  ]
  const drawText = (
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    size: number,
    color: string,
    bold = false,
  ) => {
    const lines = textLines(value, w, size),
      lineHeight = size * 1.45
    if (lines.length * lineHeight > h)
      fail(`配图文字“${value.slice(0, 25)}”超出可读区域，请缩短或拆图`)
    parts.push(
      `<text font-family="${fontFamily}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="#${color}">${lines.map((line, index) => `<tspan x="${x}" y="${y + size + index * lineHeight}">${escape(line)}</tspan>`).join('')}</text>`,
    )
  }
  drawText(plan.title, 72, 92, 1456, 110, 40, t.foreground, true)
  const levels = new Map<string, number>()
  const level = (node: Node): number => {
    const known = levels.get(node.id)
    if (known !== undefined) return known
    const value = node.parentId
      ? level(plan.nodes.find((n) => n.id === node.parentId)!) + 1
      : 0
    levels.set(node.id, value)
    return value
  }
  const maxLevel =
    plan.layout === 'organization' ? Math.max(...plan.nodes.map(level)) : 0
  const columns =
    plan.layout === 'compare'
      ? Math.min(3, plan.nodes.length)
      : plan.nodes.length <= 3
        ? plan.nodes.length
        : 3
  const rows = Math.ceil(plan.nodes.length / columns),
    gap = 32
  const boxes: Box[] = plan.nodes.map((node, index) => {
    const row =
      plan.layout === 'organization' ? level(node) : Math.floor(index / columns)
    const peers =
      plan.layout === 'organization'
        ? plan.nodes.filter((other) => level(other) === row)
        : plan.nodes.slice(row * columns, (row + 1) * columns)
    const count = peers.length,
      column = peers.indexOf(node),
      colWidth = Math.min(680, (1456 - gap * (count - 1)) / count)
    const rowCount = plan.layout === 'organization' ? maxLevel + 1 : rows
    const available = (600 - gap * (rowCount - 1)) / rowCount
    const boxHeight = Math.min(
      available,
      plan.layout === 'organization'
        ? 190
        : plan.layout === 'metrics'
          ? 300
          : 260,
    )
    const top = 220 + (600 - (boxHeight * rowCount + gap * (rowCount - 1))) / 2
    return {
      node,
      x:
        (1600 - (colWidth * count + gap * (count - 1))) / 2 +
        column * (colWidth + gap),
      y: top + row * (boxHeight + gap),
      w: colWidth,
      h: boxHeight,
    }
  })
  // Connections are routed through gutters, behind content. No connector crosses a text box.
  const path = (d: string) =>
    parts.push(
      `<path d="${d}" fill="none" stroke="#${t.secondary}" stroke-width="3" stroke-linejoin="round"/>`,
    )
  for (const [index, box] of boxes.entries()) {
    if (plan.layout === 'organization' && box.node.parentId) {
      const parent = boxes.find((b) => b.node.id === box.node.parentId)!
      const middle = (parent.y + parent.h + box.y) / 2
      path(
        `M${parent.x + parent.w / 2},${parent.y + parent.h} V${middle} H${box.x + box.w / 2} V${box.y}`,
      )
    } else if (['flow', 'timeline'].includes(plan.layout) && index) {
      const previous = boxes[index - 1]!
      if (previous.y === box.y) {
        const y = box.y + (plan.layout === 'timeline' ? 0 : box.h / 2)
        path(`M${previous.x + previous.w},${y} H${box.x}`)
        if (plan.layout === 'flow')
          path(`M${box.x - 9},${y - 6} L${box.x},${y} L${box.x - 9},${y + 6}`)
      } else {
        const gutter = previous.y + previous.h + gap / 2
        path(
          `M${previous.x + previous.w / 2},${previous.y + previous.h} V${gutter} H${box.x + box.w / 2} V${box.y}`,
        )
      }
    }
  }
  for (const [index, b] of boxes.entries()) {
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="18" fill="#${t.surface}"/><rect x="${b.x + 24}" y="${b.y + 24}" width="38" height="5" rx="2" fill="#${t.accent}"/>`,
    )
    if (plan.layout === 'timeline')
      parts.push(
        `<path d="M${b.x},${b.y} H${b.x + b.w}" stroke="#${t.secondary}" stroke-width="3"/><circle cx="${b.x + 43}" cy="${b.y}" r="10" fill="#${t.accent}" stroke="#${t.background}" stroke-width="4"/>`,
      )
    const numbered = ['flow', 'timeline'].includes(plan.layout)
    if (numbered)
      drawText(
        String(index + 1).padStart(2, '0'),
        b.x + 24,
        b.y + 41,
        62,
        48,
        26,
        t.accent,
        true,
      )
    const tx = b.x + 24 + (numbered ? 68 : 0),
      tw = b.w - 48 - (numbered ? 68 : 0)
    const titleHeight = textLines(b.node.title, tw, 27).length * 27 * 1.45
    drawText(
      b.node.title,
      tx,
      b.y + 41,
      tw,
      Math.min(120, b.h - 65),
      27,
      t.foreground,
      true,
    )
    let y = b.y + 52 + titleHeight
    if (b.node.value) {
      drawText(b.node.value, b.x + 24, y, b.w - 48, 90, 43, t.accent, true)
      y += 90
    }
    if (b.node.detail)
      drawText(
        b.node.detail,
        b.x + 24,
        y,
        b.w - 48,
        b.y + b.h - 22 - y,
        23,
        t.foreground,
      )
  }
  parts.push('</svg>')
  return parts.join('')
}

export function renderIllustration(plan: IllustrationPlan) {
  const svg = illustrationSvg(plan)
  const renderer = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [
        join(officeFontDirectory, 'NotoSansCJKsc-Regular.otf'),
        join(officeFontDirectory, 'NotoSansCJKsc-Bold.otf'),
      ],
      defaultFontFamily: fontFamily,
    },
    languages: ['zh-CN'],
    logLevel: 'off',
  })
  const png = renderer.render().asPng()
  if (png.readUInt32BE(16) !== 1600 || png.readUInt32BE(20) !== 900)
    fail('配图渲染结果尺寸不一致')
  return {
    content: png,
    filename: '配图.png',
    mediaType: 'image/png',
    summary: {
      layout: plan.layout,
      nodes: plan.nodes.length,
      renderer: 'structured-json',
      width: 1600,
      height: 900,
    },
    diagnostics: [
      '结构化 JSON 经确定性布局和字体度量渲染；未调用图像生成模型。图内事实与数值仍须核对来源。',
    ],
  }
}
