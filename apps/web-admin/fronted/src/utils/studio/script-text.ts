import type { StudioDocument } from '@/types/studio/studio'

/** 全文与场次正文共享唯一文本；一次明确替换同步移动场次范围，不用文字搜索猜位置。 */
export function replaceScript(
  document: StudioDocument,
  start: number,
  end: number,
  replacement: string,
) {
  const text = Array.from(document.script)
  const length = Array.from(replacement).length
  const delta = length - (end - start)
  for (const scene of document.scenes ?? []) {
    const range = scene.scriptRange
    if (!range || range.end <= start) continue
    if (range.start >= end) {
      range.start += delta
      range.end += delta
    } else if (range.start <= start && end <= range.end) {
      range.end += delta
      if (range.end === range.start) scene.scriptRange = null
    } else scene.scriptRange = null
  }
  document.script =
    text.slice(0, start).join('') + replacement + text.slice(end).join('')
}

/** 输入法和粘贴都按一次连续编辑计算；跨场改写时解除受影响关联，要求重新确认。 */
export function updateScript(document: StudioDocument, value: string) {
  const before = Array.from(document.script),
    after = Array.from(value)
  let start = 0,
    a = before.length,
    b = after.length
  while (start < a && start < b && before[start] === after[start]) start++
  while (a > start && b > start && before[a - 1] === after[b - 1]) {
    a--
    b--
  }
  replaceScript(document, start, a, after.slice(start, b).join(''))
}
