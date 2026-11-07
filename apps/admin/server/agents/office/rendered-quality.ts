import { fileURLToPath } from 'node:url'
import { readOfficeArchive, parseXml } from './validation.ts'
import type { OfficeInputFile } from './types.ts'

export interface RenderedQuality {
  status: 'passed' | 'draft'
  scope: 'document-layout' | 'spreadsheet-preview'
  checks: (
    | 'structure'
    | 'rendered-pages'
    | 'text-preservation'
    | 'page-boundaries'
    | 'fonts'
  )[]
  /** PDF rendering never proves spreadsheet formula recalculation. */
  calculationVerified: false
  visualModelReviewed: false
  officeClientReviewed: false
  pages: { number: number; textLength: number; issues: string[] }[]
  issues: string[]
  missingFonts: string[]
  correctionRounds: number
}
const normalized = (text: string) =>
  text.normalize('NFKC').replace(/[\s\u00ad\u200b\u2022]/gu, '')
const values = (xml: string, namespace: string, tag: string) =>
  Array.from(parseXml(xml).getElementsByTagNameNS(namespace, tag))
    .map((node) =>
      Array.from(node.getElementsByTagNameNS(namespace, 't'))
        .map((text) => text.textContent ?? '')
        .join(''),
    )
    .filter(Boolean)
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relationship =
  'http://schemas.openxmlformats.org/package/2006/relationships'

interface SourceText {
  slides: boolean
  verifyText: boolean
  margins?: { top: number; bottom: number }
  texts: string[][]
}

async function sourceTexts(file: OfficeInputFile): Promise<SourceText> {
  const zip = readOfficeArchive(file, {
    allowChartWorkbooks: file.filename.endsWith('.pptx'),
  })
  const document = zip.file('word/document.xml')
  if (document) {
    const xml = await document.async('string')
    const margin = parseXml(xml).getElementsByTagNameNS(word, 'pgMar')[0]
    return {
      slides: false,
      verifyText: true,
      margins: {
        top: Number(margin?.getAttributeNS(word, 'top') ?? 1440) / 20,
        bottom: Number(margin?.getAttributeNS(word, 'bottom') ?? 1440) / 20,
      },
      texts: [
        values(xml, word, 'p')
          .map(normalized)
          .filter((text) => text.length >= 5),
      ],
    }
  }
  const workbook = zip.file('xl/workbook.xml')
  if (workbook) {
    // Print areas, hidden sheets and number formatting intentionally differ from
    // source cells. Validate the rendered pages without claiming recalculation.
    parseXml(await workbook.async('string'))
    return { slides: false, verifyText: false, texts: [] }
  }
  const presentationPart = zip.file('ppt/presentation.xml')
  const relationshipsPart = zip.file('ppt/_rels/presentation.xml.rels')
  if (!presentationPart || !relationshipsPart)
    throw new Error('Office 文档缺少主体或页面关系，无法检查渲染结果')
  const presentation = parseXml(await presentationPart.async('string'))
  const links = parseXml(await relationshipsPart.async('string'))
  const mapping = new Map(
    Array.from(links.getElementsByTagNameNS(relationship, 'Relationship')).map(
      (node) => [node.getAttribute('Id'), node.getAttribute('Target')],
    ),
  )
  const texts = []
  for (const slide of Array.from(
    presentation.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/presentationml/2006/main',
      'sldId',
    ),
  )) {
    const id = slide.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    )
    const target = mapping.get(id)
    if (!target) throw new Error('幻灯片关系缺失')
    const path = target.startsWith('/') ? target.slice(1) : 'ppt/' + target
    const part = zip.file(path)
    if (!part) throw new Error('幻灯片页面缺失')
    texts.push(
      values(await part.async('string'), drawing, 'p')
        .map(normalized)
        .filter((text) => text.length >= 5),
    )
  }
  return { slides: true, verifyText: true, texts }
}

/** Inspects text and geometry from the PDF produced from the exact final OOXML bytes. */
export async function checkRenderedDocument(
  file: OfficeInputFile,
  pdf: Buffer,
  missingFonts: string[],
): Promise<RenderedQuality> {
  const source = await sourceTexts(file)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: Uint8Array.from(pdf),
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: fileURLToPath(
      new URL(
        '../../standard_fonts/',
        import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      ),
    ).replaceAll('\\', '/'),
    cMapUrl: fileURLToPath(
      new URL(
        '../../cmaps/',
        import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      ),
    ).replaceAll('\\', '/'),
    cMapPacked: true,
  })
  const pages: RenderedQuality['pages'] = [],
    issues: string[] = [],
    textByPage: string[] = []
  try {
    const document = await task.promise
    if (document.numPages > 240)
      throw new Error('渲染结果超过 240 页，需拆分文档')
    if (source.slides && document.numPages !== source.texts.length)
      issues.push(
        `PPT 应有 ${source.texts.length} 页，实际渲染为 ${document.numPages} 页`,
      )
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number),
        content = await page.getTextContent()
      const bounds = page.view
      const items = content.items.filter((item) => 'str' in item)
      const rawText = items.map((item) => item.str).join('')
      // Page headers/footers interrupt body paragraphs in PDF extraction order.
      // Exclude only text physically inside OOXML's reserved margins, not matching
      // words in the body; this preserves repeated content and exact numbers.
      const bodyItems = source.margins
        ? items.filter(
            (item) =>
              item.transform[5]! >= source.margins!.bottom - 6 &&
              item.transform[5]! <= bounds[3]! - source.margins!.top + 6,
          )
        : items
      textByPage.push(normalized(bodyItems.map((item) => item.str).join('')))
      const pageIssues: string[] = []
      for (const item of items) {
        if (!item.str.trim()) continue
        const [a, b, c, d, x, y] = item.transform
        if ([a, b, c, d, x, y].some((value) => !Number.isFinite(value))) {
          pageIssues.push('文字坐标无效')
          continue
        }
        // Horizontal normal text only; rotated graphics are checked by the layout model.
        if (
          Math.abs(b!) < 0.1 &&
          Math.abs(c!) < 0.1 &&
          (x! < bounds[0]! - 2 ||
            x! + item.width > bounds[2]! + 2 ||
            y! < bounds[1]! - 2 ||
            y! + item.height * 0.8 > bounds[3]! + 2)
        )
          pageIssues.push('文字超出实际页面边界：' + item.str.slice(0, 35))
      }
      if (source.slides) {
        const expected = source.texts[number - 1] ?? []
        for (const text of expected)
          if (!textByPage[number - 1]!.includes(text))
            pageIssues.push('渲染文字缺失或被截断：' + text.slice(0, 55))
      }
      if (!rawText.trim())
        pageIssues.push('页面没有可提取文字，请检查空白页或纯图片页面')
      pages.push({
        number,
        textLength: rawText.length,
        issues: [...new Set(pageIssues)].slice(0, 20),
      })
      page.cleanup()
    }
    if (!source.slides && source.verifyText) {
      const all = textByPage.join('')
      for (const text of source.texts[0] ?? [])
        if (!all.includes(text))
          issues.push('文档文字缺失或被截断：' + text.slice(0, 55))
    }
  } finally {
    await task.destroy()
  }
  if (missingFonts.length)
    issues.push('字体缺失或替换：' + missingFonts.join('、'))
  return {
    scope: source.verifyText ? 'document-layout' : 'spreadsheet-preview',
    calculationVerified: false,
    status:
      issues.length || pages.some((page) => page.issues.length)
        ? 'draft'
        : 'passed',
    checks: [
      'structure',
      'rendered-pages',
      ...(source.verifyText ? (['text-preservation'] as const) : []),
      'page-boundaries',
      'fonts',
    ],
    visualModelReviewed: false,
    officeClientReviewed: false,
    pages,
    issues: issues.slice(0, 40),
    missingFonts,
    correctionRounds: 0,
  }
}
