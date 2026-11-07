import { XMLSerializer } from '@xmldom/xmldom'
import { readOfficeArchive, parseXml } from './validation.ts'
import type { OfficeInputFile } from './types.ts'
import type { RenderedQuality } from './rendered-quality.ts'

/** Bounded typography/pagination repair, never changes text, numbers or paid assets. */
export async function repairRenderedDocument(
  file: OfficeInputFile,
  quality: RenderedQuality,
  round: number,
): Promise<Buffer | null> {
  if (
    round < 1 ||
    round > 2 ||
    quality.status !== 'draft' ||
    quality.missingFonts.length
  )
    return null
  const presentation = file.filename.toLowerCase().endsWith('.pptx')
  const zip = readOfficeArchive(file, { allowChartWorkbooks: presentation })
  const names = presentation
    ? zip.file(/^ppt\/slides\/slide\d+\.xml$/).map((part) => part.name)
    : ['word/document.xml']
  const serializer = new XMLSerializer()
  let changed = false
  for (const name of names) {
    const part = zip.file(name)
    if (!part) continue
    const document = parseXml(await part.async('string'))
    if (presentation) {
      const namespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
      for (const properties of Array.from(
        document.getElementsByTagNameNS(namespace, 'rPr'),
      )) {
        const size = Number(properties.getAttribute('sz'))
        if (size > 1800) {
          properties.setAttribute(
            'sz',
            String(Math.max(1700, Math.floor(size * 0.94))),
          )
          changed = true
        }
      }
    } else {
      const namespace =
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      // Never remove heading keepNext; allow long body paragraphs to split across pages.
      for (const paragraph of Array.from(
        document.getElementsByTagNameNS(namespace, 'p'),
      )) {
        if (
          Array.from(paragraph.getElementsByTagNameNS(namespace, 't')).reduce(
            (sum, text) => sum + (text.textContent?.length ?? 0),
            0,
          ) < 500
        )
          continue
        const properties = paragraph.getElementsByTagNameNS(namespace, 'pPr')[0]
        if (!properties) continue
        for (const tag of ['keepLines', 'keepNext'])
          for (const node of Array.from(
            properties.getElementsByTagNameNS(namespace, tag),
          )) {
            node.parentNode?.removeChild(node)
            changed = true
          }
      }
    }
    zip.file(name, serializer.serializeToString(document))
  }
  return changed
    ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    : null
}
