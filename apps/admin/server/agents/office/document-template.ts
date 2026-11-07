import { posix } from 'node:path'
import { XMLSerializer } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import { parseXml, readOfficeArchive } from './validation.ts'

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const serialize = (value: Parameters<XMLSerializer['serializeToString']>[0]) =>
  new XMLSerializer().serializeToString(value)

export async function inspectDocumentTemplate(file: OfficeInputFile) {
  const archive = readOfficeArchive(file)
  const documentPart = archive.file('word/document.xml'),
    styles = archive.file('word/styles.xml')
  if (!documentPart || !styles)
    throw new OfficeInputError('Word 模板缺少正文或样式')
  const document = parseXml(await documentPart.async('string'))
  const sections = Array.from(document.getElementsByTagNameNS(w, 'sectPr'))
  if (sections.length !== 1)
    throw new OfficeInputError(
      '当前支持单节企业 Word 模板；请先移除复杂分节，保留页眉、页脚和样式',
    )
  if (
    document.getElementsByTagNameNS(w, 'altChunk').length ||
    document.getElementsByTagNameNS(w, 'object').length ||
    document.getElementsByTagNameNS(w, 'sdt').length ||
    document.getElementsByTagNameNS(w, 'txbxContent').length
  )
    throw new OfficeInputError(
      'Word 模板含外部内容、嵌入对象、内容控件或文本框，无法可靠复用；请使用普通企业文档模板',
    )
  for (const entry of Object.values(archive.files).filter((item) =>
    /^word\/(?:document|header\d+|footer\d+)\.xml$/u.test(item.name),
  )) {
    const xml = parseXml(await entry.async('string'))
    for (const field of Array.from(xml.getElementsByTagNameNS(w, 'instrText')))
      if (
        !/^\s*(?:PAGE|NUMPAGES|TOC|PAGEREF|REF)\b/iu.test(
          field.textContent ?? '',
        )
      )
        throw new OfficeInputError(
          'Word 模板包含不支持的复杂域；请将该域转换为普通文本',
        )
  }
  const externalStyles = await styles.async('string')
  const styleDoc = parseXml(externalStyles)
  const defaults = Array.from(styleDoc.getElementsByTagNameNS(w, 'style')).find(
    (item) =>
      item.getAttributeNS(w, 'default') === '1' &&
      item.getAttributeNS(w, 'type') === 'paragraph',
  )
  const font =
    defaults?.getElementsByTagNameNS(w, 'rFonts')[0] ??
    styleDoc.getElementsByTagNameNS(w, 'rFonts')[0]
  const fontFace =
    font?.getAttributeNS(w, 'eastAsia') ||
    font?.getAttributeNS(w, 'ascii') ||
    undefined
  const headerCount = sections[0]!.getElementsByTagNameNS(
    w,
    'headerReference',
  ).length
  const footerCount = sections[0]!.getElementsByTagNameNS(
    w,
    'footerReference',
  ).length
  return {
    archive,
    externalStyles,
    fontFace,
    headerCount,
    footerCount,
    styles: Array.from(styleDoc.getElementsByTagNameNS(w, 'style'))
      .slice(0, 150)
      .map((item) => ({
        id: item.getAttributeNS(w, 'styleId'),
        name: item
          .getElementsByTagNameNS(w, 'name')[0]
          ?.getAttributeNS(w, 'val'),
      })),
  }
}

/** Reuse headers/footers and their image parts without flattening the new document. */
export async function applyDocumentTemplate(
  content: Buffer,
  template: Awaited<ReturnType<typeof inspectDocumentTemplate>>,
) {
  const output = await JSZip.loadAsync(content),
    input = template.archive
  const document = parseXml(
    await output.file('word/document.xml')!.async('string'),
  )
  const relations = parseXml(
    await output.file('word/_rels/document.xml.rels')!.async('string'),
  )
  const originalDocument = parseXml(
    await input.file('word/document.xml')!.async('string'),
  )
  const originalRelations = parseXml(
    await input.file('word/_rels/document.xml.rels')!.async('string'),
  )
  const targetTypes = parseXml(
    await output.file('[Content_Types].xml')!.async('string'),
  )
  const sourceTypes = parseXml(
    await input.file('[Content_Types].xml')!.async('string'),
  )
  const copied = new Set<string>()
  async function copyPart(path: string): Promise<string> {
    if (!path.startsWith('word/') || path.includes('..'))
      throw new OfficeInputError('模板关系超出 Word 包范围')
    const target = 'word/template-assets/' + path.slice(5)
    if (copied.has(path)) return target
    copied.add(path)
    const part = input.file(path)
    if (!part) throw new OfficeInputError('Word 模板引用了缺失素材')
    output.file(target, await part.async('nodebuffer'))
    const sourceOverride = Array.from(
      sourceTypes.getElementsByTagName('Override'),
    ).find((item) => item.getAttribute('PartName') === '/' + path)
    if (sourceOverride) {
      const node = targetTypes.importNode(sourceOverride, true)
      node.setAttribute('PartName', '/' + target)
      targetTypes.documentElement!.appendChild(node)
    }
    const relationPath = posix.join(
      posix.dirname(path),
      '_rels',
      posix.basename(path) + '.rels',
    )
    const sourceRelation = input.file(relationPath)
    if (sourceRelation) {
      const xml = parseXml(await sourceRelation.async('string'))
      for (const relation of Array.from(
        xml.getElementsByTagName('Relationship'),
      )) {
        if (relation.getAttribute('TargetMode') === 'External')
          throw new OfficeInputError('Word 模板不支持外部关系')
        const referenced = posix.normalize(
          posix.join(
            posix.dirname(path),
            relation.getAttribute('Target') ?? '',
          ),
        )
        const mapped = await copyPart(referenced)
        relation.setAttribute(
          'Target',
          posix.relative(posix.dirname(target), mapped),
        )
      }
      output.file(
        posix.join(
          posix.dirname(target),
          '_rels',
          posix.basename(target) + '.rels',
        ),
        serialize(xml),
      )
    }
    return target
  }
  for (const entry of Array.from(sourceTypes.getElementsByTagName('Default')))
    if (
      !Array.from(targetTypes.getElementsByTagName('Default')).some(
        (item) =>
          item.getAttribute('Extension') === entry.getAttribute('Extension'),
      )
    )
      targetTypes.documentElement!.appendChild(
        targetTypes.importNode(entry, true),
      )
  const targetSection = document.getElementsByTagNameNS(w, 'sectPr')[0]!
  const sourceSection = originalDocument.getElementsByTagNameNS(w, 'sectPr')[0]!
  for (const kind of ['headerReference', 'footerReference']) {
    const references = Array.from(sourceSection.getElementsByTagNameNS(w, kind))
    if (!references.length) continue
    for (const old of Array.from(targetSection.getElementsByTagNameNS(w, kind)))
      targetSection.removeChild(old)
    for (const [index, reference] of references.entries()) {
      const oldId = reference.getAttributeNS(r, 'id')
      const relation = Array.from(
        originalRelations.getElementsByTagName('Relationship'),
      ).find((item) => item.getAttribute('Id') === oldId)
      if (!relation || relation.getAttribute('TargetMode') === 'External')
        throw new OfficeInputError('Word 模板页眉页脚关系无效')
      const target = await copyPart(
        posix.normalize(
          posix.join('word', relation.getAttribute('Target') ?? ''),
        ),
      )
      const id = 'superdsh-template-' + kind + '-' + index
      const copiedRelation = relations.importNode(relation, true)
      copiedRelation.setAttribute('Id', id)
      copiedRelation.setAttribute('Target', posix.relative('word', target))
      relations.documentElement!.appendChild(copiedRelation)
      const copiedReference = document.importNode(reference, true)
      copiedReference.setAttributeNS(r, 'r:id', id)
      targetSection.insertBefore(copiedReference, targetSection.firstChild)
    }
  }
  output.file('word/document.xml', serialize(document))
  output.file('word/_rels/document.xml.rels', serialize(relations))
  output.file('[Content_Types].xml', serialize(targetTypes))
  return output.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
