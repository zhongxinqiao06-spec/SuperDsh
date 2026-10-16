import {
  OfficeInputError,
  type KnowledgeText,
  type OfficeInputFile,
} from './types.ts'
import {
  OFFICE_LIMITS,
  parseXml,
  readOfficeArchive,
  validateInput,
} from './validation.ts'
import { readTable } from './sales.ts'

export async function extractKnowledgeText(
  file: OfficeInputFile,
): Promise<KnowledgeText> {
  const extension = validateInput(file, [
    '.txt',
    '.md',
    '.csv',
    '.xlsx',
    '.docx',
  ])
  let text: string
  if (extension === '.csv' || extension === '.xlsx') {
    text = (await readTable(file)).map((row) => row.join('\t')).join('\n')
  } else if (extension === '.docx') {
    const archive = readOfficeArchive(file)
    const part = archive.file('word/document.xml')
    if (!part) throw new OfficeInputError('文件不是有效的 DOCX 文档')
    const document = parseXml(await part.async('string'))
    text = Array.from(
      document.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'p',
      ),
    )
      .map((paragraph) =>
        Array.from(
          paragraph.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            't',
          ),
        )
          .map((node) => node.textContent)
          .join(''),
      )
      .join('\n')
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.content)
    } catch {
      throw new OfficeInputError('知识文本必须使用 UTF-8 编码')
    }
  }
  text = text.replace(/^\uFEFF/u, '').trim()
  if (
    !text ||
    text.length > OFFICE_LIMITS.textCharacters ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)
  ) {
    throw new OfficeInputError(
      '知识文本为空、含控制字符或超过 100000 字符，请拆分后上传',
    )
  }
  return { filename: file.filename, text }
}
