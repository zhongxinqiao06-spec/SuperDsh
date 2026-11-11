const { model, revision, dimensions, baseUrl } = JSON.parse(
  process.env.SUPERDSH_KNOWLEDGE_EMBEDDING_DEFAULT,
)
const origin = new URL(baseUrl).origin

async function request(path, body, timeout = 30_000) {
  const response = await fetch(new URL(path, origin), {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`Ollama ${path} 返回 ${response.status}`)
  return response.json()
}

async function installedModel() {
  const { models } = await request('/api/tags')
  return models.find((entry) => entry.name === model)
}

// 复用持久卷中的固定版本。远端标签发生漂移时终止启动，避免现有索引混入不同权重。
let installed = await installedModel()
if (!installed) {
  await request('/api/pull', { model, stream: false }, 15 * 60_000)
  installed = await installedModel()
}
if (installed?.digest !== revision) throw new Error(`模型摘要不符：${model}`)

const { data } = await request('/v1/embeddings', {
  model,
  input: ['知识库启动检查'],
  encoding_format: 'float',
})
const vector = data?.[0]?.embedding
if (
  !Array.isArray(vector) ||
  vector.length !== dimensions ||
  !vector.every(Number.isFinite) ||
  !vector.some((value) => value !== 0)
)
  throw new Error(`模型未返回有效的 ${dimensions} 维向量`)
console.log(`Ollama 已就绪：${model}，${dimensions} 维，摘要 ${revision}`)
