import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { generateOfficePresentation } from '../agents/office/generic-presentation.ts'
import { generateOfficeDocument } from '../agents/office/document.ts'
import { presentationThemes } from '../agents/office/design-themes.ts'
import { renderOfficeAssetPreview } from '../agents/office/preview.ts'
import { renderedQuality } from '../agents/office/rendered-quality-client.ts'
import { reviseDocumentStructure } from '../agents/office/document-revision.ts'

const block = (id, title, text) => ({ id, title, type: 'text', text })
const page = (id, title, layout, blocks) => ({
  id,
  title,
  kind: 'design',
  design: { layout, blocks },
})
const cover = (title) => ({
  id: 'cover',
  title,
  kind: 'title',
  body: ['星河科技（虚构企业）', '本文件仅使用脱敏示例资料'],
})
const company = {
  title: '星河科技｜让资料成为可靠成果',
  audience: '企业业务负责人',
  purpose: '确认试用范围与交付标准',
  designTheme: presentationThemes[0],
  slides: [
    cover('让资料成为可靠的业务成果'),
    page('context', '企业需要的是可复用的工作方法', 'split', [
      block(
        'now',
        '现状',
        '制度、模板和经营数据分散在不同岗位，重复整理占用业务时间。',
      ),
      block(
        'goal',
        '目标',
        '将企业资料与经确认的业务方法组合为可配置助手，保留可核查的来源。',
      ),
    ]),
    page('process', '每一步都有明确的输入与验收', 'process', [
      block('input', '提供资料', '选择有效版本，明确资料归属与使用范围。'),
      block('plan', '确认方案', '核对目标、字段口径和版式后再执行。'),
      block('review', '复核交付', '检查结果、下载原文件，并保留修订记录。'),
    ]),
    page('boundary', '先验证一个流程，再扩大使用范围', 'compare', [
      block(
        'scope',
        '本轮纳入',
        '销售汇总、制度问答与办公文件生成；采用脱敏材料验收。',
      ),
      block(
        'excluded',
        '需另行评估',
        '复杂宏、扫描件识别及外部业务系统写入，不能默认宣称已支持。',
      ),
    ]),
    page('decision', '建议以两周试用验证业务价值', 'timeline', [
      block('week1', '第一周', '整理资料，选定模板，明确验收人员。'),
      block('week2', '第二周', '执行真实任务，记录问题，完成结果复核。'),
    ]),
  ],
}
const product = {
  ...company,
  title: '企业办公助手试用方案',
  designTheme: presentationThemes[1],
  slides: [cover('用同一套流程交付多种成果'), ...company.slides.slice(1)],
}
const report = {
  ...company,
  title: '季度经营复盘（虚构数据）',
  slides: [
    cover('交付数量增长，质量仍需持续复核'),
    page('metrics', '用明确口径解读季度交付', 'grid', [
      {
        id: 'a',
        type: 'metric',
        title: '一季度交付',
        value: '36 项',
        caption: '示例数据；按验收项目计数',
      },
      {
        id: 'b',
        type: 'metric',
        title: '二季度交付',
        value: '45 项',
        caption: '示例数据；口径同上',
      },
      {
        id: 'c',
        type: 'metric',
        title: '同比基准',
        value: '待补充',
        caption: '未提供去年同期数据，不计算同比',
      },
    ]),
    page('chart', '季度增长来自交付节奏改善', 'split', [
      block(
        'insight',
        '可确认的结论',
        '二季度比一季度多交付 9 项，增幅为 25%。不能据此推断利润变化。',
      ),
      {
        id: 'trend',
        type: 'chart',
        title: '验收项目数',
        chart: {
          type: 'bar',
          categories: ['一季度', '二季度'],
          series: [{ name: '项目数', values: [36, 45] }],
        },
      },
    ]),
    page('next', '下一步补齐质量与投入数据', 'process', [
      block('source', '补充来源', '核实每项交付的验收记录。'),
      block('cost', '核对投入', '补充工时及费用，不编造利润。'),
      block('review', '复盘改进', '按统一口径形成下一周期报告。'),
    ]),
  ],
}
const training = {
  ...company,
  title: '新员工资料使用培训',
  designTheme: presentationThemes[2],
  slides: [
    cover('先核对来源，再使用资料'),
    page('steps', '三步完成资料使用检查', 'process', [
      block('find', '找到有效版本', '检查文件标题、更新时间和适用部门。'),
      block('check', '确认使用授权', '不将客户资料上传到未批准的平台。'),
      block('cite', '保留引用证据', '标注原文出处，区分事实与个人推断。'),
    ]),
    page('exercise', '练习：两份制度冲突时怎么办', 'compare', [
      block('wrong', '不能直接做', '按文件名或个人印象选择一个答案。'),
      block('right', '推荐处理', '列出冲突条款与版本，提交制度负责人确认。'),
    ]),
    ...company.slides.slice(-1),
  ],
}

async function verify(kind, label, input) {
  const result =
    kind === 'pptx'
      ? await generateOfficePresentation(input)
      : await generateOfficeDocument(input)
  const zip = await JSZip.loadAsync(result.content)
  assert.ok(
    zip.file(kind === 'pptx' ? 'ppt/presentation.xml' : 'word/document.xml'),
  )
  const file = { filename: label + '.' + kind, content: result.content }
  const preview = await renderOfficeAssetPreview(file)
  const quality = await renderedQuality(
    file,
    Buffer.from(preview.contentBase64, 'base64'),
    preview.missingFonts,
    new AbortController().signal,
  )
  assert.equal(quality.status, 'passed', JSON.stringify(quality))
  assert.equal(quality.visualModelReviewed, false)
  const output = process.env.SUPERDSH_OFFICE_ACCEPTANCE_OUTPUT
  if (output) {
    const folder = resolve(output)
    assert.ok(
      folder.startsWith(
        resolve(tmpdir()) + '\\superdsh-extension-acceptance-',
      ) ||
        folder.startsWith(
          resolve(tmpdir()) + '/superdsh-extension-acceptance-',
        ),
    )
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, file.filename), result.content)
    await writeFile(
      join(folder, label + '.pdf'),
      Buffer.from(preview.contentBase64, 'base64'),
    )
    await writeFile(
      join(folder, label + '.quality.json'),
      JSON.stringify(quality, null, 2),
    )
  }
}
for (const [label, plan] of [
  ['P01-company', company],
  ['P02-product', product],
  ['P03-results', report],
  ['P04-training', training],
])
  test(
    label + ' editable final file passes actual rendering',
    { timeout: 120000 },
    () => verify('pptx', label, { plan }),
  )

const change = (id, value) => ({ op: 'replace', id, value })
const patch = (changes) => ({ baseHash: 'original', changes })
test('P05 change only one page preserves other complete page structures', async () => {
  const revised = reviseDocumentStructure(
    company,
    patch([
      change(
        'context',
        page('context', '先明确业务问题与责任人', 'split', [
          block('a', '业务问题', '明确要减少的重复劳动。'),
          block('b', '责任人', '指定资料、执行和验收负责人。'),
        ]),
      ),
    ]),
    'original',
  )
  assert.deepEqual(revised.slides[2], company.slides[2])
  assert.deepEqual(company.slides[1].title, '企业需要的是可复用的工作方法')
  await verify('pptx', 'P05-page-revision', { plan: revised })
})
test('P06 insert and remove pages preserves explicit narrative order', async () => {
  const revised = reviseDocumentStructure(
    company,
    patch([
      { op: 'remove', id: 'boundary' },
      {
        op: 'insertAfter',
        id: 'context',
        value: page('new', '试用前确认三项准备', 'grid', [
          block('a', '资料', '真实有效并可授权使用'),
          block('b', '模型', '使用已批准的供应商'),
          block('c', '验收', '明确可交付的成果'),
        ]),
      },
    ]),
    'original',
  )
  assert.deepEqual(
    revised.slides.map((item) => item.id),
    ['cover', 'context', 'new', 'process', 'decision'],
  )
  await verify('pptx', 'P06-page-order', { plan: revised })
})
test('P07 change a chart retains exact editable numbers', async () => {
  const revised = structuredClone(report)
  revised.slides[2].design.blocks[1].chart.series[0].values = [0, -12.34]
  const result = await generateOfficePresentation({ plan: revised })
  const zip = await JSZip.loadAsync(result.content)
  assert.match(
    await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async('string'),
    /-12\.34/,
  )
  assert.ok(zip.file(/^ppt\/embeddings\/.*\.xlsx$/).length)
})
test('P08 style revision retains original content', async () => {
  const revised = reviseDocumentStructure(
    company,
    { ...patch([]), designTheme: presentationThemes[1] },
    'original',
  )
  assert.deepEqual(revised.slides, company.slides)
  await verify('pptx', 'P08-style', { plan: revised })
})
for (const [label, input, expected] of [
  [
    'P09 missing narrative pages',
    { ...company, slides: [] },
    /幻灯片|页面|slides/,
  ],
  [
    'P10 unknown layout',
    {
      ...company,
      slides: [page('a', '标题', 'arbitrary', [block('a', '说明', '内容')])],
    },
    /布局/,
  ],
  [
    'P11 unsupported object',
    {
      ...company,
      slides: [page('a', '标题', 'split', [{ id: 'a', type: 'script' }])],
    },
    /组件|类型/,
  ],
  [
    'P12 unauthorized image',
    {
      ...company,
      slides: [
        page('a', '标题', 'split', [
          { id: 'a', type: 'image', imageId: 'foreign' },
        ]),
      ],
    },
    /授权图片/,
  ],
  [
    'P13 excessive Chinese density',
    {
      ...company,
      slides: [
        page('a', '标题', 'split', [
          block('a', '超长内容', '保留所有中文内容。'.repeat(600)),
        ]),
      ],
    },
    /超出|过长|超过/,
  ],
  [
    'P14 invalid theme color',
    { ...company, designTheme: { accent: 'javascript:' } },
    /颜色/,
  ],
  [
    'P15 invalid font path',
    { ...company, designTheme: { fontFace: '../secret' } },
    /字体/,
  ],
  [
    'P16 duplicate page identity',
    { ...company, slides: [cover('A'), cover('B')] },
    /重复/,
  ],
])
  test(label, () =>
    assert.rejects(() => generateOfficePresentation({ plan: input }), expected),
  )
test('P17 stale document revision cannot overwrite newer plan', () =>
  assert.throws(
    () => reviseDocumentStructure(company, patch([]), 'new'),
    /版本/,
  ))
test('P18 unknown page must not overwrite a nearby page', () =>
  assert.throws(
    () =>
      reviseDocumentStructure(
        company,
        patch([change('unknown', { id: 'unknown' })]),
        'original',
      ),
    /未找到/,
  ))
test('P19 page identity cannot change during replacement', () =>
  assert.throws(
    () =>
      reviseDocumentStructure(
        company,
        patch([change('context', { id: 'other' })]),
        'original',
      ),
    /保留/,
  ))
test('P20 decorative shapes may overlap, content regions may not', async () => {
  await assert.rejects(
    () =>
      generateOfficePresentation({
        plan: {
          ...company,
          slides: [
            page('a', '重叠检查', 'canvas', [
              {
                ...block('a', '甲', '正文'),
                region: { x: 0, y: 0, w: 0.8, h: 1 },
              },
              {
                ...block('b', '乙', '正文'),
                region: { x: 0.2, y: 0, w: 0.8, h: 1 },
              },
            ]),
          ],
        },
      }),
    /重叠/,
  )
})

const document = (title, sections) => ({
  title,
  subtitle: '星河科技（虚构企业）· 内部试用评审',
  brand: { company: '星河科技' },
  sections,
})
const section = (id, title, text) => ({
  id,
  title,
  blocks: [{ type: 'paragraph', text }],
})
const sop = document('公司资料使用制度', [
  section(
    'scope',
    '适用范围',
    '本制度适用于内部资料整理与成果交付。未经批准的客户数据不得作为演示资料。',
  ),
  section(
    'roles',
    '职责分工',
    '资料负责人确认版本与适用范围，执行人员按确认方案制作成果，复核人员核对关键事实。',
  ),
  {
    id: 'checks',
    title: '交付检查',
    blocks: [
      {
        type: 'table',
        columns: ['检查项', '完成标准'],
        rows: [
          ['来源', '每项关键结论均有可查依据'],
          ['文件', '原文件可以打开与修改'],
          ['版本', '修改产生新成果并保留旧版'],
        ],
      },
    ],
  },
])
const docs = [
  [
    'W01-proposal',
    document('办公助手试用方案', [
      section(
        'goal',
        '试用目标',
        '验证企业资料在三个常用办公场景中的复用能力，不将示例效果当作实际收益。',
      ),
      section(
        'scope',
        '范围与边界',
        '先验证资料问答、经营汇总和文档生成；复杂宏及对外业务写入需另行评估。',
      ),
      ...sop.sections.slice(1),
    ]),
  ],
  ['W02-sop', sop],
  [
    'W03-report',
    document('资料管理现状调研报告', [
      section(
        'method',
        '调研方法',
        '本报告依据脱敏访谈材料，未完成样本抽样，结论只用于试用设计。',
      ),
      section(
        'findings',
        '主要发现',
        '资料版本与审批记录分散。尚无可验证的节省工时数据，不推算收益。',
      ),
      section(
        'next',
        '下一步',
        '补充资料台账、版本责任人和实际任务样本后再评估成效。',
      ),
    ]),
  ],
  [
    'W04-minutes',
    document('试用启动会议纪要', [
      section(
        'context',
        '会议背景',
        '虚构企业试用启动会，参会人员以岗位代称，不含真实客户信息。',
      ),
      {
        id: 'actions',
        title: '行动项',
        blocks: [
          {
            type: 'table',
            columns: ['行动', '责任岗位', '截止'],
            rows: [
              ['确认资料目录', '资料负责人', '试用前'],
              ['验证文件交付', '复核人员', '首周结束'],
              ['汇总问题清单', '项目负责人', '两周结束'],
            ],
          },
        ],
      },
    ]),
  ],
  [
    'W05-training',
    document('新员工资料使用手册', [
      section('intro', '先确认资料来源', '核对标题、日期、版本与适用岗位。'),
      {
        id: 'steps',
        title: '操作步骤',
        blocks: [
          {
            type: 'list',
            ordered: true,
            items: ['选择已批准资料', '核对最新有效版本', '记录引用与处理意见'],
          },
        ],
      },
      section(
        'exercise',
        '练习与复核',
        '遇到冲突资料时列出双方条款，交由负责人确认，不能擅自选择答案。',
      ),
    ]),
  ],
]
for (const [label, plan] of docs)
  test(
    label + ' final editable Word renders all sections',
    { timeout: 120000 },
    () => verify('docx', label, { plan }),
  )
test(
  'W06 long Chinese paragraphs paginate without content loss',
  { timeout: 120000 },
  () =>
    verify('docx', 'W06-long-chinese', {
      plan: document('较长制度说明', [
        section(
          'long',
          '业务资料管理',
          '资料使用应当明确来源、版本和使用范围。每次交付须核对关键事实，保留可编辑原文件以及修订说明。'.repeat(
            24,
          ),
        ),
      ]),
    }),
)
test(
  'W07 long tables repeat header on subsequent pages',
  { timeout: 120000 },
  () =>
    verify('docx', 'W07-long-table', {
      plan: document('交付检查台账', [
        {
          id: 'table',
          title: '逐项检查',
          blocks: [
            {
              type: 'table',
              columns: ['序号', '检查内容', '责任岗位'],
              rows: Array.from({ length: 35 }, (_, i) => [
                String(i + 1),
                '确认当前资料版本与结果依据',
                '复核人员',
              ]),
            },
          ],
        },
      ]),
    }),
)
test('W08 chapter revision preserves unaffected chapters', async () => {
  const plan = reviseDocumentStructure(
    sop,
    patch([
      change(
        'scope',
        section(
          'scope',
          '适用范围',
          '本版新增培训材料整理场景，仍需使用已批准资料。',
        ),
      ),
    ]),
    'original',
  )
  assert.deepEqual(plan.sections.slice(1), sop.sections.slice(1))
  await verify('docx', 'W08-chapter-revision', { plan })
})
test('W09 source quotes carry verified exact evidence', async () => {
  const text = '员工可参加公司安排的岗位培训。'
  await verify('docx', 'W09-citation', {
    plan: document('培训制度摘要', [
      {
        id: 'rules',
        title: '原文与解释',
        blocks: [{ type: 'quote', text, sourceId: 'policy' }],
      },
    ]),
    sources: [{ id: 'policy', filename: '脱敏制度.md', text }],
  })
})
test('W10 precise values remain editable table cells', async () => {
  const result = await generateOfficeDocument({
    plan: document('费用汇总', [
      {
        id: 'cost',
        title: '示例费用',
        blocks: [
          {
            type: 'table',
            columns: ['项目', '人民币元'],
            rows: [
              ['支出', '1234.56'],
              ['退款', '-12.34'],
            ],
          },
        ],
      },
    ]),
  })
  const xml = await (
    await JSZip.loadAsync(result.content)
  )
    .file('word/document.xml')
    .async('string')
  assert.match(xml, /1234\.56/)
  assert.match(xml, /-12\.34/)
})
for (const [label, plan, expected] of [
  ['W11 missing chapters', { ...sop, sections: [] }, /章节/],
  [
    'W12 duplicate chapter identity',
    { ...sop, sections: [sop.sections[0], sop.sections[0]] },
    /重复/,
  ],
  [
    'W13 unsupported active content',
    document('非法内容', [
      { id: 'x', title: '内容', blocks: [{ type: 'script', text: 'execute' }] },
    ]),
    /只支持/,
  ],
  [
    'W14 unauthorized image',
    document('图片', [
      {
        id: 'x',
        title: '内容',
        blocks: [{ type: 'image', imageId: 'foreign' }],
      },
    ]),
    /授权素材/,
  ],
  [
    'W15 fabricated citation',
    document('引用', [
      {
        id: 'x',
        title: '内容',
        blocks: [{ type: 'quote', sourceId: 'foreign', text: '伪造原文' }],
      },
    ]),
    /授权资料/,
  ],
  [
    'W16 inconsistent columns',
    document('表格', [
      {
        id: 'x',
        title: '内容',
        blocks: [{ type: 'table', columns: ['甲', '乙'], rows: [['缺列']] }],
      },
    ]),
    /列数/,
  ],
  [
    'W17 unsupported heading',
    { ...sop, sections: [{ ...sop.sections[0], level: 4 }] },
    /标题级别/,
  ],
  [
    'W18 invalid brand color',
    { ...sop, brand: { accentColor: 'url()' } },
    /主题色/,
  ],
])
  test(label, () =>
    assert.rejects(() => generateOfficeDocument({ plan }), expected),
  )
test('W19 stale chapter revisions are rejected', () =>
  assert.throws(() => reviseDocumentStructure(sop, patch([]), 'new'), /版本/))
test('W20 removal cannot leave an empty document', () =>
  assert.throws(
    () =>
      reviseDocumentStructure(
        sop,
        patch(sop.sections.map((item) => ({ op: 'remove', id: item.id }))),
        'original',
      ),
    /至少/,
  ))
