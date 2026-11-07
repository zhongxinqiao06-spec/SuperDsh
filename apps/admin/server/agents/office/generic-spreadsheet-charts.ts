import JSZip from 'jszip'
import { columnIndex, excelColumn } from './formula.ts'
import type {
  OfficeSpreadsheetPlan,
  SpreadsheetTable,
} from './generic-spreadsheet-types.ts'
import { OfficeInputError } from './types.ts'

type Chart = NonNullable<
  OfficeSpreadsheetPlan['sheets'][number]['charts']
>[number]
export interface WorkbookChart {
  sheetId: number
  sheetName: string
  table: SpreadsheetTable
  charts: Chart[]
}
const xml = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
const relationships = (content: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${content}</Relationships>`

export function validateWorkbookChart(table: SpreadsheetTable, chart: Chart) {
  columnIndex(table, chart.category)
  if (
    !chart.values.length ||
    chart.values.length > 6 ||
    (chart.type === 'pie' && chart.values.length !== 1)
  )
    throw new OfficeInputError('图表需要 1–6 个数值系列，饼图只能有一个系列')
  if (!table.rows.length || table.rows.length > 50)
    throw new OfficeInputError('图表需要 1–50 行数据，请先筛选或分组汇总')
  for (const column of chart.values) {
    const index = columnIndex(table, column)
    if (
      table.rows.some(
        (row) => typeof row[index] !== 'number' || !Number.isFinite(row[index]),
      )
    )
      throw new OfficeInputError(
        `图表字段 ${column} 含非数值，请先转换或处理空值`,
      )
  }
  if (
    chart.type === 'pie' &&
    table.rows.some(
      (row) => Number(row[columnIndex(table, chart.values[0]!)]) < 0,
    )
  )
    throw new OfficeInputError('饼图不能包含负数，请使用柱状图')
}

function chartXml(
  chart: Chart,
  table: SpreadsheetTable,
  sheetName: string,
  id: number,
) {
  validateWorkbookChart(table, chart)
  const quoted = `'${sheetName.replaceAll("'", "''")}'`
  const end = table.rows.length + 1
  const category = columnIndex(table, chart.category)
  const series = chart.values
    .map((name, index) => {
      const column = columnIndex(table, name)
      const colors = [
        '2563EB',
        '10B981',
        'F59E0B',
        '8B5CF6',
        'EF4444',
        '06B6D4',
      ]
      return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>${xml(`${quoted}!$${excelColumn(column)}$1`)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xml(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${colors[index]}"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="${colors[index]}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strRef><c:f>${xml(`${quoted}!$${excelColumn(category)}$2:$${excelColumn(category)}$${end}`)}</c:f><c:strCache><c:ptCount val="${table.rows.length}"/>${table.rows.map((row, i) => `<c:pt idx="${i}"><c:v>${xml(row[category] ?? '')}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${xml(`${quoted}!$${excelColumn(column)}$2:$${excelColumn(column)}$${end}`)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${table.rows.length}"/>${table.rows.map((row, i) => `<c:pt idx="${i}"><c:v>${row[column]}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`
    })
    .join('')
  const catId = id * 2 + 100_000,
    valId = catId + 1
  const axes =
    chart.type === 'pie'
      ? ''
      : `<c:catAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="${valId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0.##" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="${catId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  const body =
    chart.type === 'pie'
      ? `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart>`
      : chart.type === 'line'
        ? `<c:lineChart><c:grouping val="standard"/>${series}<c:axId val="${catId}"/><c:axId val="${valId}"/></c:lineChart>`
        : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series}<c:gapWidth val="100"/><c:axId val="${catId}"/><c:axId val="${valId}"/></c:barChart>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:lang val="zh-CN"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1600"/><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${body}${axes}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
}

/** Add native OOXML charts with live worksheet references; no rendered image substitution. */
export async function addEditableWorkbookCharts(
  bytes: Buffer,
  specifications: WorkbookChart[],
) {
  if (!specifications.some((item) => item.charts.length)) return bytes
  const archive = await JSZip.loadAsync(bytes)
  let contentTypes = await archive.file('[Content_Types].xml')!.async('string')
  let chartId = 0
  for (const specification of specifications) {
    if (!specification.charts.length) continue
    const drawingId = specification.sheetId
    let anchors = '',
      relations = ''
    for (const [position, chart] of specification.charts.entries()) {
      const id = ++chartId,
        top = specification.table.rows.length + 4 + position * 22
      archive.file(
        `xl/charts/chart${id}.xml`,
        chartXml(chart, specification.table, specification.sheetName, id),
      )
      contentTypes = contentTypes.replace(
        '</Types>',
        `<Override PartName="/xl/charts/chart${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
      )
      relations += `<Relationship Id="rId${position + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${id}.xml"/>`
      anchors += `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${top}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${top + 20}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${xml(chart.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${position + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
    }
    archive.file(
      `xl/drawings/drawing${drawingId}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`,
    )
    archive.file(
      `xl/drawings/_rels/drawing${drawingId}.xml.rels`,
      relationships(relations),
    )
    const sheetPath = `xl/worksheets/sheet${specification.sheetId}.xml`
    const sheet = await archive.file(sheetPath)!.async('string')
    archive.file(
      sheetPath,
      sheet.replace(
        '</worksheet>',
        '<drawing r:id="rIdOfficeChart"/></worksheet>',
      ),
    )
    const relationPath = `xl/worksheets/_rels/sheet${specification.sheetId}.xml.rels`
    const relation = `<Relationship Id="rIdOfficeChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingId}.xml"/>`
    const existing = await archive.file(relationPath)?.async('string')
    archive.file(
      relationPath,
      existing
        ? existing.replace('</Relationships>', `${relation}</Relationships>`)
        : relationships(relation),
    )
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/xl/drawings/drawing${drawingId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
    )
  }
  archive.file('[Content_Types].xml', contentTypes)
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
