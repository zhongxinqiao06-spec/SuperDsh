import { parentPort, workerData } from 'node:worker_threads'
import {
  inspectSpreadsheetInputs,
  prepareOfficeSpreadsheet,
  generateOfficeWorkbook,
  validateOfficeSpreadsheetPlan,
} from './office/generic-spreadsheet.ts'
import {
  generateOfficePresentation,
  validateOfficePresentationPlan,
  inspectOfficePresentationTemplate,
} from './office/generic-presentation.ts'
import {
  generateOfficeDocument,
  validateOfficeDocumentPlan,
  inspectDocumentTemplate,
} from './office/document.ts'
import { extractKnowledgeText } from './office/knowledge.ts'
import type { ResolvedOfficeSource } from './office-sources.ts'
import type { Row } from '../infrastructure/database.ts'
import {
  validateIllustration,
  illustrationSvg,
  renderIllustration,
} from './office/illustration.ts'

interface Request {
  operation: 'inspect' | 'prepare' | 'generate'
  tool: string
  document: unknown
  sources: ResolvedOfficeSource[]
}
type Handler = (request: Request) => Promise<unknown>

async function documents(request: Request) {
  const knowledge = []
  for (const item of request.sources.filter(
    (source) =>
      source.reference.role === 'knowledge' ||
      (source.reference.role === 'input' &&
        /\.(txt|md|docx|pdf|csv|xlsx)$/i.test(source.file.filename)),
  )) {
    const extracted = await extractKnowledgeText(item.file)
    knowledge.push({
      id: item.reference.id,
      filename: item.file.filename,
      text: extracted.text,
    })
  }
  return {
    template: request.sources.find((item) => item.reference.role === 'template')
      ?.file,
    sources: knowledge,
    images: request.sources
      .filter((item) => item.reference.role === 'image')
      .map((item) => ({ id: item.reference.id, file: item.file })),
  }
}
const handlers: Readonly<Record<string, Handler>> = {
  async illustration_render(request) {
    if (request.operation === 'inspect')
      return {
        layouts: ['flow', 'timeline', 'organization', 'compare', 'metrics'],
        size: { width: 1600, height: 900 },
        note: '提交结构化 JSON，由本地绘图工具确定性渲染，无额外生图供应商费用。',
      }
    const plan = validateIllustration(request.document)
    if (request.operation === 'prepare') {
      illustrationSvg(plan)
      return {
        document: plan,
        preflight: {
          diagnostics: ['配图按 JSON 中的明确文字与数值渲染；请确认内容来源。'],
        },
      }
    }
    return renderIllustration(plan)
  },
  async spreadsheet_report(request) {
    const inputs = request.sources
      .filter((item) => item.reference.role === 'input')
      .map((item) => item.file)
    const template = request.sources.find(
      (item) => item.reference.role === 'template',
    )?.file
    if (request.operation === 'inspect') {
      const result = await inspectSpreadsheetInputs(inputs)
      return {
        ...result,
        tables: result.tables.map((table) => ({
          ...table,
          totalRows: table.rows.length,
          rows: table.rows.slice(0, 12),
          rowNumbers: table.rowNumbers.slice(0, 12),
        })),
      }
    }
    const plan = validateOfficeSpreadsheetPlan(request.document)
    const options = { inputs, plan, template }
    if (request.operation === 'prepare')
      return {
        document: plan,
        preflight: await prepareOfficeSpreadsheet(options),
      }
    return generateOfficeWorkbook(options)
  },
  async presentation_report(request) {
    const options = await documents(request)
    if (request.operation === 'inspect') {
      const template = options.template
        ? await inspectOfficePresentationTemplate(options.template)
        : null
      return {
        sources: options.sources.map((source) => ({
          ...source,
          text: source.text.slice(0, 16000),
        })),
        template: template
          ? {
              slides: template.slides,
              width: template.width,
              height: template.height,
            }
          : null,
        images: request.sources
          .filter((item) => item.reference.role === 'image')
          .map((item) => item.reference),
      }
    }
    const plan = validateOfficePresentationPlan(request.document)
    const result = await generateOfficePresentation({ ...options, plan })
    return request.operation === 'prepare'
      ? {
          document: plan,
          preflight: { diagnostics: result.diagnostics, slides: result.pages },
        }
      : result
  },
  async document_report(request) {
    const options = await documents(request)
    if (request.operation === 'inspect') {
      const template = options.template
        ? await inspectDocumentTemplate(options.template)
        : null
      return {
        sources: options.sources.map((source) => ({
          ...source,
          text: source.text.slice(0, 16000),
        })),
        template: template
          ? {
              styles: template.styles,
              fontFace: template.fontFace,
              headerCount: template.headerCount,
              footerCount: template.footerCount,
            }
          : null,
        images: request.sources
          .filter((item) => item.reference.role === 'image')
          .map((item) => item.reference),
      }
    }
    const plan = validateOfficeDocumentPlan(request.document)
    const result = await generateOfficeDocument({ ...options, plan })
    return request.operation === 'prepare'
      ? {
          document: plan,
          preflight: {
            diagnostics: result.diagnostics,
            sections: result.pages,
          },
        }
      : result
  },
}

async function work(): Promise<unknown> {
  const request = workerData as Request
  const handler = handlers[request.tool]
  if (!handler) throw new Error('此工具没有注册文档处理器')
  return handler({
    ...request,
    sources: request.sources.map((item) => ({
      ...item,
      file: { ...item.file, content: Buffer.from(item.file.content) },
    })),
  })
}
void work().then(
  (value) => parentPort!.postMessage({ value: value as Row }),
  (error: unknown) =>
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : '办公文件处理失败',
    }),
)
