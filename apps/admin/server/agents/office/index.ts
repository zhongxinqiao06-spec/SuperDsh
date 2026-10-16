export * from './types.ts'
export { extractKnowledgeText } from './knowledge.ts'
export { parseSalesFile, summarizeSales } from './sales.ts'
export {
  generateSalesWorkbook,
  createSalesWorkbookTemplate,
} from './spreadsheet.ts'
export {
  generateSalesPresentation,
  createSalesPresentationTemplate,
} from './presentation.ts'
export { createDemoAssets } from './samples.ts'

import { inspectPresentationTemplate } from './presentation.ts'
import { inspectWorkbookTemplate } from './spreadsheet.ts'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import { validateInput } from './validation.ts'

export async function validateOfficeTemplate(
  file: OfficeInputFile,
  kind: 'xlsx' | 'pptx',
) {
  if (kind !== 'xlsx' && kind !== 'pptx')
    throw new OfficeInputError('模板类型必须为 xlsx 或 pptx')
  validateInput(file, [`.${kind}`])
  const { placeholders } =
    kind === 'xlsx'
      ? await inspectWorkbookTemplate(file)
      : await inspectPresentationTemplate(file)
  return {
    kind,
    placeholders,
    warnings: [
      kind === 'xlsx'
        ? '支持受控占位符模板，生成文件保留可编辑公式及计算缓存；实际 Excel 打开时重算。'
        : '支持普通文本框占位符；动画、音视频和表格占位符不支持，输出需检查文本框排版。',
    ],
  }
}
