/** 生成旧真实 Office 成果作为差分参照；所有输入从标准输入取得，不读取用户文件。 */
import { readFileSync } from 'node:fs'

type Fields = Record<string, unknown>
interface Artifact {
  filename: string
  mediaType: string
  content: Buffer
}
interface Fixture {
  kind: 'xlsx' | 'docx' | 'pptx'
  plan: Fields
  sources?: { id: string; filename: string; text: string }[]
  inputs?: { filename: string; contentBase64: string }[]
}
const root = new URL('../../../admin/server/agents/office/', import.meta.url)
const modules = {
  xlsx: ['generic-spreadsheet.ts', 'generateOfficeWorkbook'],
  docx: ['document.ts', 'generateOfficeDocument'],
  pptx: ['generic-presentation.ts', 'generateOfficePresentation'],
} as const

async function generate(fixture: Fixture): Promise<unknown> {
  const [path, method] = modules[fixture.kind]
  const module = (await import(new URL(path, root).href)) as Record<
    string,
    (input: Fields) => Promise<Artifact>
  >
  try {
    const result = await module[method]!({
      plan: fixture.plan,
      sources: fixture.sources || [],
      inputs: (fixture.inputs || []).map((input) => ({
        filename: input.filename,
        content: Buffer.from(input.contentBase64, 'base64'),
      })),
    })
    return {
      valid: true,
      filename: result.filename,
      mediaType: result.mediaType,
      contentBase64: result.content.toString('base64'),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'OfficeInputError')
      return { valid: false, error: error.message }
    throw error
  }
}

const fixtures = JSON.parse(readFileSync(0, 'utf8')) as Fixture[]
// 顺序生成限制 Word/PPT/XLSX 库同时持有的文档对象数量。
const results: unknown[] = []
for (const fixture of fixtures) results.push(await generate(fixture))
process.stdout.write(JSON.stringify(results))
