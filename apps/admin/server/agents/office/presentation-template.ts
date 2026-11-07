import { posix } from 'node:path'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import { OFFICE_LIMITS, parseXml, readOfficeArchive } from './validation.ts'

export const drawingNamespace =
  'http://schemas.openxmlformats.org/drawingml/2006/main'
export const presentationNamespace =
  'http://schemas.openxmlformats.org/presentationml/2006/main'
const relationshipNamespace =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const emuPerInch = 914400

export interface PresentationRegion {
  x: number
  y: number
  w: number
  h: number
}

export interface PresentationTemplateShape {
  name: string
  text: string
  region?: PresentationRegion
  fontSize?: number
  fontFace?: string
  role?: string
}

export interface PresentationTemplateSlide {
  /** Visible, one-based order from presentation.xml, not a ZIP part number. */
  number: number
  partNumber: number
  partName: string
  shapes: PresentationTemplateShape[]
  objects: {
    name: string
    kind: 'picture' | 'graphic'
    region?: PresentationRegion
  }[]
}

export async function inspectOfficePresentationTemplate(file: OfficeInputFile) {
  const archive = readOfficeArchive(file, { allowChartWorkbooks: true })
  const presentationPart = archive.file('ppt/presentation.xml')
  const relationshipsPart = archive.file('ppt/_rels/presentation.xml.rels')
  if (!presentationPart || !relationshipsPart)
    throw new OfficeInputError('PPT 模板缺少演示文稿或页面关系')
  const presentation = parseXml(await presentationPart.async('string'))
  const relationships = new Map(
    Array.from(
      parseXml(await relationshipsPart.async('string')).getElementsByTagNameNS(
        '*',
        'Relationship',
      ),
    ).map((item) => [item.getAttribute('Id'), item]),
  )
  const dimensions = presentation.getElementsByTagNameNS(
    presentationNamespace,
    'sldSz',
  )[0]
  const width = Number(dimensions?.getAttribute('cx')) / emuPerInch
  const height = Number(dimensions?.getAttribute('cy')) / emuPerInch
  if (!(width > 0 && height > 0 && width <= 40 && height <= 40))
    throw new OfficeInputError('PPT 页面尺寸无效或超过 40 英寸')
  const pageIds = Array.from(
    presentation.getElementsByTagNameNS(presentationNamespace, 'sldId'),
  )
  if (!pageIds.length || pageIds.length > OFFICE_LIMITS.slides)
    throw new OfficeInputError('PPT 模板需为 1–20 页')
  const seen = new Set<string>()
  const slides: PresentationTemplateSlide[] = []
  for (const [index, page] of pageIds.entries()) {
    const relationship = relationships.get(
      page.getAttributeNS(relationshipNamespace, 'id') ??
        page.getAttribute('r:id'),
    )
    if (!relationship?.getAttribute('Type')?.endsWith('/slide'))
      throw new OfficeInputError('PPT 页面关系类型无效')
    const target = relationship.getAttribute('Target') ?? ''
    const partName = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join('ppt', target))
    const match = /^ppt\/slides\/slide(\d+)\.xml$/u.exec(partName)
    const part = archive.file(partName)
    if (!match || !part || seen.has(partName))
      throw new OfficeInputError('PPT 页面关系含无效、缺失或重复页面')
    seen.add(partName)
    const document = parseXml(await part.async('string'))
    if (
      document.getElementsByTagNameNS(presentationNamespace, 'timing').length ||
      document.getElementsByTagNameNS(drawingNamespace, 'videoFile').length ||
      document.getElementsByTagNameNS(drawingNamespace, 'audioFile').length ||
      document.getElementsByTagNameNS(presentationNamespace, 'grpSp').length
    )
      throw new OfficeInputError(
        `模板第 ${index + 1} 页含动画、音视频或组合对象，请先拆解或移除`,
      )
    const shapes: PresentationTemplateShape[] = []
    const objects: PresentationTemplateSlide['objects'] = []
    const names = new Set<string>()
    for (const shape of Array.from(
      document.getElementsByTagNameNS(presentationNamespace, 'sp'),
    )) {
      const name = shape
        .getElementsByTagNameNS(presentationNamespace, 'cNvPr')[0]
        ?.getAttribute('name')
      if (!name || names.has(name))
        throw new OfficeInputError('PPT 模板文本框必须有唯一名称')
      names.add(name)
      const text = Array.from(
        shape.getElementsByTagNameNS(drawingNamespace, 'p'),
      )
        .map((paragraph) =>
          Array.from(paragraph.getElementsByTagNameNS(drawingNamespace, 't'))
            .map((run) => run.textContent ?? '')
            .join(''),
        )
        .join('\n')
      const transform = shape.getElementsByTagNameNS(
        drawingNamespace,
        'xfrm',
      )[0]
      const offset = transform?.getElementsByTagNameNS(
        drawingNamespace,
        'off',
      )[0]
      const extent = transform?.getElementsByTagNameNS(
        drawingNamespace,
        'ext',
      )[0]
      const region =
        offset && extent
          ? {
              x: Number(offset.getAttribute('x')) / emuPerInch,
              y: Number(offset.getAttribute('y')) / emuPerInch,
              w: Number(extent.getAttribute('cx')) / emuPerInch,
              h: Number(extent.getAttribute('cy')) / emuPerInch,
            }
          : undefined
      const properties = shape.getElementsByTagNameNS(
        drawingNamespace,
        'rPr',
      )[0]
      const size = Number(properties?.getAttribute('sz')) / 100
      const font = properties?.getElementsByTagNameNS(
        drawingNamespace,
        'latin',
      )[0]
      shapes.push({
        name,
        text,
        ...(region ? { region } : {}),
        ...(size > 0 ? { fontSize: size } : {}),
        ...(font?.getAttribute('typeface')
          ? { fontFace: font.getAttribute('typeface')! }
          : {}),
        role:
          shape
            .getElementsByTagNameNS(presentationNamespace, 'ph')[0]
            ?.getAttribute('type') ?? undefined,
      })
    }
    for (const [tag, kind] of [
      ['pic', 'picture'],
      ['graphicFrame', 'graphic'],
    ] as const) {
      for (const object of Array.from(
        document.getElementsByTagNameNS(presentationNamespace, tag),
      )) {
        const name =
          object
            .getElementsByTagNameNS(presentationNamespace, 'cNvPr')[0]
            ?.getAttribute('name') ?? ''
        const transform = object.getElementsByTagNameNS('*', 'xfrm')[0]
        const offset = transform?.getElementsByTagNameNS(
          drawingNamespace,
          'off',
        )[0]
        const extent = transform?.getElementsByTagNameNS(
          drawingNamespace,
          'ext',
        )[0]
        objects.push({
          name,
          kind,
          ...(offset && extent
            ? {
                region: {
                  x: Number(offset.getAttribute('x')) / emuPerInch,
                  y: Number(offset.getAttribute('y')) / emuPerInch,
                  w: Number(extent.getAttribute('cx')) / emuPerInch,
                  h: Number(extent.getAttribute('cy')) / emuPerInch,
                },
              }
            : {}),
        })
      }
    }
    slides.push({
      number: index + 1,
      partNumber: Number(match[1]),
      partName,
      shapes,
      objects,
    })
  }
  return { archive, width, height, slides }
}
