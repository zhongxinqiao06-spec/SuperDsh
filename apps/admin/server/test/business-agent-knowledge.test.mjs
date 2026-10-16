import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeExcerpts } from '../agents/knowledge-search.ts'

test('Chinese questions retrieve matching company evidence instead of unrelated CSV chunks', () => {
  const rows = [
    {
      id: 'sales',
      name: 'sales.csv',
      sha256: 'sales-hash',
      extracted_text: 'ORDER-1,华东,笔记本,100\n'.repeat(500),
    },
    {
      id: 'policy',
      name: '经营制度.md',
      sha256: 'policy-hash',
      extracted_text:
        '经营原则：按已确认订单安排备货，定期复核库存与商品毛利，销售结论须引用原始台账。',
    },
  ]
  const result = knowledgeExcerpts(rows, '公司的经营原则是什么？')
  assert.equal(result[0].assetId, 'policy')
  assert.equal(result[0].paragraph, 1)
  assert.equal(result[0].sha256, 'policy-hash')
  assert.match(result[0].content, /已确认订单/)
  assert.deepEqual(knowledgeExcerpts(rows, 'quantum teleportation'), [])
  assert.deepEqual(knowledgeExcerpts(rows, ''), [])
})
