import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  contractProjection,
  documentedTaskIds,
  indexedEvidence,
  templateMatches,
} from './parity-contracts.ts'

test('模板匹配忽略参数名但保留方法和多段边界', () => {
  assert.equal(templateMatches('/api/items/{id}', '/api/items/{item_id}'), true)
  assert.equal(templateMatches('/api/items/{id}', '/api/items/a/b'), false)
  assert.equal(
    templateMatches('/api/items/{path:path}', '/api/items/a/b'),
    true,
  )
  assert.equal(templateMatches('/api/items/{id}', '/api/other/a'), false)
})

test('契约摘要保留校验约束并拒绝循环引用失控', () => {
  const document = {
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: { child: { $ref: '#/components/schemas/Node' } },
        },
      },
    },
  }
  assert.deepEqual(
    contractProjection({ title: '说明', type: 'string', minLength: 2 }, {}),
    { minLength: 2, type: 'string' },
  )
  assert.notDeepEqual(
    contractProjection({ type: 'string', minLength: 2 }, {}),
    contractProjection({ type: 'string', minLength: 3 }, {}),
  )
  assert.match(
    JSON.stringify(
      contractProjection({ $ref: '#/components/schemas/Node' }, document),
    ),
    /\$recursive/u,
  )
  assert.deepEqual(contractProjection({ $ref: '#/missing' }, {}), {
    $missing: '#/missing',
  })
})

test('测试索引不得作为已执行证据', () => {
  assert.deepEqual(indexedEvidence(['synthetic-case']), {
    status: 'indexed-only',
    cases: ['synthetic-case'],
    executed: false,
  })
})

test('范围索引只读取表格编号且允许格式化后的单元格间距', () => {
  const markdown = [
    '正文 P2-99 仅为举例',
    '| P2-01     | 功能 |',
    '| P3-01 | 验证 |',
    '|P2-02|功能|',
  ].join('\n')
  assert.deepEqual(documentedTaskIds(markdown, 'P2'), ['P2-01', 'P2-02'])
  assert.deepEqual(documentedTaskIds(markdown, 'P3'), ['P3-01'])
})

test('范围表被清空、改成普通文字或重复时禁止假通过', () => {
  for (const markdown of [
    '',
    '### P2-01 未迁移的旧标题',
    '| P2-01 | 功能 |\n| P2-01 | 重复 |',
  ])
    assert.throws(() => documentedTaskIds(markdown, 'P2'), /为空或重复/u)
})

test('统一规范与现有功能清单及验收分组保持完整对应', async () => {
  const markdown = await readFile(
    new URL('../../../../docs/plans/开发规范.md', import.meta.url),
    'utf8',
  )
  const features = JSON.parse(
    await readFile(new URL('../parity/features.json', import.meta.url), 'utf8'),
  ) as {
    tasks: { id: string }[]
    evidenceGroups: { planTaskIds: string[] }[]
  }
  assert.deepEqual(
    documentedTaskIds(markdown, 'P2').sort(),
    features.tasks.map((task) => task.id).sort(),
  )
  const parityIds = documentedTaskIds(markdown, 'P3')
  assert.equal(parityIds.length, 14)
  for (const group of features.evidenceGroups)
    for (const id of group.planTaskIds)
      assert.ok(parityIds.includes(id), `验收引用未纳入统一规范：${id}`)
})
