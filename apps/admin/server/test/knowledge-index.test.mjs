import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  QdrantKnowledgeIndex,
  sparseKnowledgeVector,
  knowledgeChunks,
} from '../agents/knowledge-index.ts'

test('local sparse encoding is deterministic, Chinese-aware and bounded by normalized terms', () => {
  const left = sparseKnowledgeVector('销售华东 revenue')
  assert.deepEqual(left, sparseKnowledgeVector('销售华东 REVENUE'))
  assert.ok(left.indices.length >= 4)
  assert.ok(
    Math.abs(left.values.reduce((sum, value) => sum + value ** 2, 0) - 1) <
      1e-9,
  )
  assert.deepEqual(sparseKnowledgeVector('  !!! '), { indices: [], values: [] })
  const parts = knowledgeChunks({
    id: 'a',
    name: '制度.md',
    sha256: 'hash',
    extracted_text: '销售报销凭证'.repeat(300),
  })
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.content.length <= 900))
  assert.equal(parts[1].paragraph, 2)
})

test('real Qdrant persists chunks, retrieves Chinese sources, filters ownership and can rebuild its index', async () => {
  const url = process.env.SUPERDSH_NODE_TEST_QDRANT_URL
  assert.ok(url, 'Use scripts/test-node-server.mjs for disposable Qdrant')
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const index = new QdrantKnowledgeIndex(url)
  const owner = randomUUID()
  const other = randomUUID()
  const row = (id, name, content) => ({
    id,
    name,
    sha256: createHash('sha256').update(content).digest('hex'),
    extracted_text: content,
  })
  const permitted = row(
    randomUUID(),
    '差旅制度.md',
    '星河商贸差旅报销需要提交发票和审批单，财务复核后付款。',
  )
  const forbidden = row(
    randomUUID(),
    '另一公司.md',
    '差旅报销秘密代码：OTHER-COMPANY-SECRET。',
  )
  const unrelated = row(
    randomUUID(),
    '未关联.md',
    '差旅报销秘密代码：UNBOUND-KNOWLEDGE-SECRET。',
  )
  await index.index(other, [forbidden])
  await index.index(owner, [permitted, unrelated])
  const signal = AbortSignal.timeout(15000)
  const sources = await new QdrantKnowledgeIndex(url).search(
    owner,
    [permitted],
    '报销需要什么',
    2,
    signal,
  )
  assert.equal(sources.length, 1)
  assert.equal(sources[0].filename, '差旅制度.md')
  assert.match(sources[0].content, /发票和审批单/)
  assert.doesNotMatch(JSON.stringify(sources), /SECRET/)
  assert.equal(sources[0].sha256, permitted.sha256)
  assert.deepEqual(await index.search(owner, [], '报销', 2, signal), [])
  const rebuilt = await index.index(owner, [permitted], signal, true)
  assert.deepEqual(rebuilt, { indexedAssets: 1, chunks: 1 })
  assert.equal((await index.status()).ready, true)
  await assert.rejects(
    index.search(owner, [permitted], '报销', 2, AbortSignal.abort()),
    /abort/i,
  )
})

test('the shipped Docker healthcheck runs in the actual pinned Qdrant image', async () => {
  const container = process.env.SUPERDSH_NODE_TEST_QDRANT_CONTAINER
  assert.match(container || '', /^superdsh-node-test-qdrant-[a-f0-9]+$/)
  const config = spawnSync(
    'docker',
    [
      'compose',
      '--file',
      fileURLToPath(
        new URL('../../deployment/compose.dependencies.yml', import.meta.url),
      ),
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, POSTGRES_PASSWORD: 'synthetic-healthcheck' },
    },
  )
  assert.equal(config.status, 0, config.stderr)
  const compose = JSON.parse(config.stdout)
  assert.equal(compose.services.qdrant.image, 'qdrant/qdrant:v1.19.2')
  const [kind, ...command] = compose.services.qdrant.healthcheck.test
  assert.equal(kind, 'CMD')
  const result = spawnSync(
    'docker',
    ['exec', container, ...command.map((part) => part.replaceAll('$$', '$'))],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  )
  assert.equal(result.status, 0, result.stderr)
})
