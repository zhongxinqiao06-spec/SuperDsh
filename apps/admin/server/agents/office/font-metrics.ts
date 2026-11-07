import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openSync, type Font } from 'fontkit'

export const officeFontDirectory = fileURLToPath(
  new URL('../../../.office-fonts/', import.meta.url),
)
let font: Font | undefined
export function documentFont() {
  if (font) return font
  const path = join(officeFontDirectory, 'NotoSansCJKsc-Regular.otf')
  if (!existsSync(path)) return undefined
  const loaded = openSync(path)
  if ('layout' in loaded) font = loaded
  return font
}

/** Glyph advances from the same fixed font supplied to final Office rendering. */
export function measuredTextHeight(
  text: string,
  width: number,
  fontSize: number,
): number | undefined {
  const current = documentFont()
  if (!current) return undefined
  const available = Math.max(1, (width * 72 * current.unitsPerEm) / fontSize)
  let lines = 0
  for (const paragraph of text.split('\n')) {
    let advance = 0
    lines++
    for (const position of current.layout(paragraph).positions) {
      if (advance && advance + position.xAdvance > available) {
        lines++
        advance = 0
      }
      advance += position.xAdvance
    }
  }
  return (lines * fontSize * 1.35) / 72
}
