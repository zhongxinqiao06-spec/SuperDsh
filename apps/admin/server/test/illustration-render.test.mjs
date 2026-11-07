import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import {
  validateIllustration,
  illustrationSvg,
  renderIllustration,
} from '../agents/office/illustration.ts'
import { generateOfficePresentation } from '../agents/office/generic-presentation.ts'
import { generateOfficeDocument } from '../agents/office/document.ts'
import { officeWork } from '../agents/office-worker-client.ts'

const nodes = [
  { id: 'input', title: '确认资料', detail: '核对来源、版本和可使用范围。' },
  { id: 'plan', title: '策划方案', detail: '明确受众、提纲和需要呈现的关系。' },
  {
    id: 'deliver',
    title: '校验交付',
    detail: '逐项核对事实，保留原文件和版本。',
  },
]
for (const layout of ['flow', 'timeline', 'organization', 'compare', 'metrics'])
  test(`structured JSON renders real Chinese ${layout} artwork with fixed fonts`, async () => {
    const plan = validateIllustration({
      title: '从企业资料到可靠交付',
      layout,
      nodes: nodes.map((node, index) => ({
        ...node,
        ...(layout === 'organization' && index ? { parentId: 'input' } : {}),
        ...(layout === 'metrics'
          ? { value: ['12 项', '3 部门', '95%'][index] }
          : {}),
      })),
    })
    const svg = illustrationSvg(plan)
    assert.match(svg, /确认资料/)
    assert.doesNotMatch(svg, /<script|foreignObject|href=/)
    const result = renderIllustration(plan)
    assert.equal(result.content.readUInt32BE(16), 1600)
    assert.equal(result.content.readUInt32BE(20), 900)
    assert.ok(result.content.length > 10000)
    const folder = process.env.SUPERDSH_OFFICE_ACCEPTANCE_OUTPUT
    if (folder) {
      assert.ok(
        resolve(folder).startsWith(
          join(tmpdir(), 'superdsh-extension-acceptance-'),
        ),
      )
      await writeFile(
        join(folder, `illustration-${layout}.png`),
        result.content,
      )
    }
  })
test('JSON illustration handles escaping, invalid relations, arbitrary content and text overflow explicitly', () => {
  const base = { title: '合法 < & 标题', layout: 'flow', nodes }
  assert.match(
    illustrationSvg(validateIllustration(base)),
    /合法 &lt; &amp; 标题/,
  )
  assert.throws(
    () => validateIllustration({ ...base, url: 'http://private/image' }),
    /不支持字段/,
  )
  assert.throws(
    () => validateIllustration({ ...base, nodes: [nodes[0], nodes[0]] }),
    /重复/,
  )
  assert.throws(
    () =>
      validateIllustration({
        ...base,
        layout: 'organization',
        nodes: [
          { ...nodes[0], parentId: 'plan' },
          { ...nodes[1], parentId: 'input' },
        ],
      }),
    /根节点|循环/,
  )
  assert.throws(
    () => validateIllustration({ ...base, layout: 'metrics' }),
    /明确的数值/,
  )
  assert.throws(
    () =>
      illustrationSvg(
        validateIllustration({
          ...base,
          nodes: Array.from({ length: 9 }, (_, index) => ({
            id: String(index),
            title: '长中文标题',
            detail: '保持完整内容并拒绝静默截断。'.repeat(12),
          })),
        }),
      ),
    /超出可读区域/,
  )
})
test('the managed tool produces an authorized PNG reused by actual editable PPT and Word', async () => {
  const plan = { title: '公司资料处理流程', layout: 'flow', nodes }
  const prepared = await officeWork(
    'prepare',
    'illustration_render',
    [],
    plan,
    new AbortController().signal,
  )
  assert.equal(prepared.document.layout, 'flow')
  const generated = await officeWork(
    'generate',
    'illustration_render',
    [],
    prepared.document,
    new AbortController().signal,
  )
  const image = {
    id: 'owned-image',
    file: { filename: '配图.png', content: Buffer.from(generated.content) },
  }
  const ppt = await generateOfficePresentation({
    plan: {
      title: '流程介绍',
      slides: [
        {
          id: 'flow',
          kind: 'image',
          title: '资料如何形成交付',
          imageId: image.id,
        },
      ],
    },
    images: [image],
  })
  const word = await generateOfficeDocument({
    plan: {
      title: '流程说明',
      sections: [
        {
          id: 'flow',
          title: '操作流程',
          blocks: [
            {
              type: 'image',
              imageId: image.id,
              caption: '根据确认的流程 JSON 绘制。',
            },
          ],
        },
      ],
    },
    images: [image],
  })
  for (const [artifact, prefix] of [
    [ppt, 'ppt'],
    [word, 'word'],
  ]) {
    const zip = await JSZip.loadAsync(artifact.content)
    const media = zip.file(new RegExp(`^${prefix}/media/.*\\.png$`))
    assert.ok(media.length)
    assert.ok(
      (await Promise.all(media.map((file) => file.async('nodebuffer')))).some(
        (bytes) => bytes.equals(image.file.content),
      ),
    )
  }
})
