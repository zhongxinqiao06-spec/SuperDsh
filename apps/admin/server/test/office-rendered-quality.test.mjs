import assert from 'node:assert/strict'
import test from 'node:test'
import { generateOfficePresentation } from '../agents/office/generic-presentation.ts'
import { generateOfficeDocument } from '../agents/office/document.ts'
import { renderOfficeAssetPreview } from '../agents/office/preview.ts'
import { renderedQuality } from '../agents/office/rendered-quality-client.ts'
import { presentationThemes } from '../agents/office/design-themes.ts'
import ExcelJS from 'exceljs'

for (const kind of ['pptx', 'docx'])
  test(
    'actual final ' +
      kind +
      ' rendering preserves editable Chinese document text',
    { timeout: 120000 },
    async () => {
      const artifact =
        kind === 'pptx'
          ? await generateOfficePresentation({
              plan: {
                title: '星河科技业务方案',
                designTheme: presentationThemes[0],
                slides: [
                  {
                    id: 'cover',
                    kind: 'title',
                    title: '用清晰的流程连接业务',
                    body: ['星河科技 · 脱敏演示', '企业办公协作方案'],
                  },
                  {
                    id: 'process',
                    kind: 'design',
                    title: '从资料到可交付成果',
                    design: {
                      layout: 'process',
                      blocks: [
                        {
                          id: 'input',
                          type: 'text',
                          title: '明确输入',
                          text: '选择公司资料，确认当前任务的依据和边界。',
                        },
                        {
                          id: 'plan',
                          type: 'text',
                          title: '确认方案',
                          text: '审阅叙事、结构和输出要求，再开始执行。',
                        },
                        {
                          id: 'output',
                          type: 'text',
                          title: '校验交付',
                          text: '核对来源与结果，预览并下载可编辑文件。',
                        },
                      ],
                    },
                  },
                ],
              },
            })
          : await generateOfficeDocument({
              plan: {
                title: '星河科技办公协作制度',
                subtitle: '脱敏示例 · 供试用评审',
                brand: { company: '星河科技' },
                sections: [
                  {
                    id: 'scope',
                    title: '适用范围',
                    blocks: [
                      {
                        type: 'paragraph',
                        text: '本制度适用于公司内部办公资料整理、方案审阅与成果交付。所有业务结论应有明确依据，不得补造未确认的事实。',
                      },
                    ],
                  },
                  {
                    id: 'responsibility',
                    title: '职责分工',
                    blocks: [
                      {
                        type: 'table',
                        columns: ['角色', '职责'],
                        rows: [
                          ['资料负责人', '确认资料来源、版本和适用范围'],
                          ['执行人员', '依据确认方案制作可编辑成果'],
                          ['复核人员', '核对关键数字、引用和交付文件'],
                        ],
                      },
                    ],
                  },
                ],
              },
            })
      const file = { filename: 'acceptance.' + kind, content: artifact.content }
      const preview = await renderOfficeAssetPreview(file)
      const result = await renderedQuality(
        file,
        Buffer.from(preview.contentBase64, 'base64'),
        preview.missingFonts,
        new AbortController().signal,
      )
      assert.equal(result.visualModelReviewed, false)
      assert.equal(result.officeClientReviewed, false)
      assert.ok(result.pages.length > 0)
      assert.equal(result.status, 'passed', JSON.stringify(result, null, 2))
    },
  )

test(
  'XLSX artifact preview checks rendered pages without parsing PPT parts or claiming formula verification',
  { timeout: 120000 },
  async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('收入明细')
    sheet.addRow(['项目', '金额', '合计'])
    sheet.addRow(['培训', 125, { formula: 'B2*2', result: 250 }])
    sheet.columns.forEach((column) => {
      column.width = 22
    })
    sheet.eachRow((row) => {
      row.font = { name: 'Noto Sans CJK SC', size: 11 }
    })
    const file = {
      filename: '收入明细.xlsx',
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
    }
    const preview = await renderOfficeAssetPreview(file)
    const result = await renderedQuality(
      file,
      Buffer.from(preview.contentBase64, 'base64'),
      preview.missingFonts,
      new AbortController().signal,
    )
    assert.equal(result.scope, 'spreadsheet-preview')
    assert.equal(result.calculationVerified, false)
    assert.ok(!result.checks.includes('text-preservation'))
    assert.equal(result.pages.length, 1)
    assert.equal(result.pages[0].issues.length, 0)
    assert.ok(result.pages[0].textLength > 0)
  },
)
