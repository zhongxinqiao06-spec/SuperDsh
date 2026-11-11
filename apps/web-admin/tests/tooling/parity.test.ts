import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contractProjection,
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
