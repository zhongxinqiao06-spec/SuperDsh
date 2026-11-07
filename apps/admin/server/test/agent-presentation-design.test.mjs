import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { generateOfficePresentation } from '../agents/office/generic-presentation.ts'
import { presentationThemes } from '../agents/office/design-themes.ts'

const textBlock = (id, title = '流程说明') => ({
  id,
  type: 'text',
  title,
  text: '先确认目标，再按已确认的资料执行。',
})
const plan = (design, extra = {}) => ({
  title: '企业业务方案（脱敏）',
  audience: '业务负责人',
  purpose: '确认可执行的办公流程',
  designTheme: presentationThemes[0],
  slides: [
    { id: 'decision', title: '从分散资料到一致行动', kind: 'design', design },
  ],
  ...extra,
})
const xml = async (artifact) =>
  (await JSZip.loadAsync(artifact.content))
    .file('ppt/slides/slide1.xml')
    .async('string')

for (const layout of ['split', 'grid', 'process', 'timeline', 'compare'])
  test(
    'PPT ' +
      layout +
      ' uses editable native components with consistent brand and page furniture',
    async () => {
      const artifact = await generateOfficePresentation({
        plan: plan({
          layout,
          blocks: [textBlock('a', '明确输入'), textBlock('b', '执行与验收')],
        }),
      })
      const content = await xml(artifact)
      assert.match(content, /明确输入/)
      assert.match(content, /执行与验收/)
      assert.match(content, /design-text/)
      assert.match(content, /brand-page/)
      assert.doesNotMatch(content, /<p:pic>/)
    },
  )

test('PPT canvas composes native metrics, shapes and tables while retaining exact source values', async () => {
  const artifact = await generateOfficePresentation({
    plan: plan({
      layout: 'canvas',
      blocks: [
        {
          id: 'background',
          type: 'shape',
          shape: 'ellipse',
          decorative: true,
          region: { x: 0, y: 0, w: 0.3, h: 0.8 },
        },
        {
          id: 'metric',
          type: 'metric',
          title: '本期交付',
          value: '24 项',
          caption: '来源：用户确认的交付清单',
          region: { x: 0, y: 0, w: 0.4, h: 1 },
        },
        {
          id: 'table',
          type: 'table',
          title: '分阶段交付',
          table: {
            columns: ['阶段', '项目数'],
            rows: [
              ['一期', 10],
              ['二期', 14],
            ],
          },
          region: { x: 0.44, y: 0, w: 0.56, h: 1 },
        },
      ],
    }),
  })
  const content = await xml(artifact)
  assert.match(content, /24 项/)
  assert.match(content, /<a:tbl>/)
  assert.match(content, /<a:t>14<\/a:t>/)
  assert.match(content, /ellipse/)
})

test('a company name alone does not erase the configured theme colors or font', async () => {
  const theme = presentationThemes[1]
  const artifact = await generateOfficePresentation({
    plan: plan(
      { layout: 'split', blocks: [textBlock('a'), textBlock('b')] },
      { designTheme: theme, brand: { company: '脱敏企业' } },
    ),
  })
  const content = await xml(artifact)
  assert.match(content, new RegExp(theme.accent))
  assert.match(content, new RegExp(theme.background))
  assert.match(content, new RegExp(theme.fontFace))
})

test('PPT design charts remain native editable charts with embedded workbooks', async () => {
  const artifact = await generateOfficePresentation({
    plan: plan({
      layout: 'split',
      blocks: [
        textBlock('explain'),
        {
          id: 'trend',
          type: 'chart',
          title: '交付趋势',
          chart: {
            type: 'bar',
            categories: ['一月', '二月'],
            series: [{ name: '项目', values: [12, 15] }],
          },
        },
      ],
    }),
  })
  const zip = await JSZip.loadAsync(artifact.content)
  assert.ok(zip.file(/^ppt\/charts\/chart\d+\.xml$/).length)
  assert.ok(zip.file(/^ppt\/embeddings\/.*\.xlsx$/).length)
})

for (const theme of presentationThemes)
  test(
    'PPT theme resource ' + theme.id + ' applies editable colors and fonts',
    async () => {
      const artifact = await generateOfficePresentation({
        plan: plan(
          { layout: 'split', blocks: [textBlock('a'), textBlock('b')] },
          { designTheme: theme },
        ),
      })
      const content = await xml(artifact)
      assert.match(content, new RegExp(theme.accent))
      assert.match(content, new RegExp(theme.background))
      assert.match(content, new RegExp(theme.fontFace))
    },
  )

test('PPT non-decorative overlaps and missing authorized imagery fail preflight', async () => {
  await assert.rejects(
    () =>
      generateOfficePresentation({
        plan: plan({
          layout: 'canvas',
          blocks: [
            { ...textBlock('a'), region: { x: 0, y: 0, w: 0.7, h: 1 } },
            { ...textBlock('b'), region: { x: 0.3, y: 0, w: 0.7, h: 1 } },
          ],
        }),
      }),
    /重叠/,
  )
  await assert.rejects(
    () =>
      generateOfficePresentation({
        plan: plan({
          layout: 'split',
          blocks: [
            textBlock('a'),
            { id: 'b', type: 'image', imageId: 'not-authorized' },
          ],
        }),
      }),
    /授权图片/,
  )
})

test('PPT long Chinese content is rejected instead of shrunk to unreadable text', async () => {
  await assert.rejects(
    () =>
      generateOfficePresentation({
        plan: plan({
          layout: 'grid',
          blocks: [
            {
              id: 'a',
              type: 'text',
              title: '长中文测试',
              text: '这是必须保留的长中文。'.repeat(90),
            },
            textBlock('b'),
            textBlock('c'),
            textBlock('d'),
            textBlock('e'),
            textBlock('f'),
          ],
        }),
      }),
    /超出版面/,
  )
})
