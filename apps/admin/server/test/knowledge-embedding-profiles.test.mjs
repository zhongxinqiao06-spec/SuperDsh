import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { KnowledgeEmbeddingProfiles } from '../agents/embedding-profiles.ts'

/** Storage fixture tests orchestration and secret handling; PostgreSQL integration is separate. */
function storage() {
  let value = null,
    leased = false
  const calls = []
  const query = async (sql, args) => {
    if (sql.startsWith('SELECT value FROM')) return value ? [{ value }] : []
    if (sql.includes('FROM business_agent_assets'))
      return args?.[0]
        ? []
        : [
            {
              id: 'asset',
              name: 'synthetic.md',
              sha256: 'hash',
              extracted_text: '报销需要审批',
              owner_user_id: 'owner',
            },
          ]
    if (sql.startsWith('INSERT INTO instance_settings')) {
      value = args[1]
      return []
    }
    throw new Error(`Unexpected fixture query ${sql}`)
  }
  return {
    calls,
    stored: () => value,
    db: {
      query,
      transaction: (operation) => operation({ query }),
      lease: async () => {
        if (leased) return null
        leased = true
        return {
          lost: new Promise(() => {}),
          release: async () => {
            leased = false
          },
        }
      },
    },
  }
}

async function fixture(t) {
  const requests = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    assert.equal(
      request.headers.authorization,
      'Bearer SYNTHETIC-EMBEDDING-SECRET',
    )
    const body = JSON.parse(raw)
    requests.push(body)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  const origin = `http://127.0.0.1:${server.address().port}`
  const store = storage()
  const options = {
    db: store.db,
    encryptionKey: randomBytes(32).toString('base64url'),
    localModelDirectory: 'unused-local-fixture',
    allowedOrigins: origin,
    trustedOrigins: origin,
    getAccount: async () => ({
      permissions: ['models.manage', 'agents.manage'],
      disabled: false,
      deletedAt: null,
      resetRequired: false,
    }),
    audit: async (...args) => store.calls.push(args),
  }
  const profiles = new KnowledgeEmbeddingProfiles(options)
  await profiles.initialize()
  const input = {
    version: 0,
    kind: 'openai-compatible',
    baseUrl: `${origin}/v1`,
    model: 'embedding-test',
    dimensions: 2,
    revision: 'r1',
    apiKey: 'SYNTHETIC-EMBEDDING-SECRET',
  }
  return { profiles, input, store, options, requests }
}

test('profile activation stages a distinct candidate, encrypts its key and survives process reload', async (t) => {
  const { profiles, input, store, options } = await fixture(t)
  const activeBefore = profiles.embedding()
  let indexed
  const index = {
    index: async (owner, rows, _signal, force, candidate) => {
      assert.equal(profiles.embedding(), activeBefore)
      assert.equal(candidate.profile.kind, 'openai-compatible')
      indexed = { owner, rows, force }
    },
  }
  const result = await profiles.save(
    'admin',
    input,
    index,
    AbortSignal.timeout(5000),
  )
  assert.equal(indexed.owner, 'owner')
  assert.equal(result.profile.apiKeyConfigured, true)
  assert.equal(result.version, 1)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-EMBEDDING-SECRET/)
  assert.doesNotMatch(store.stored(), /SYNTHETIC-EMBEDDING-SECRET/)
  assert.doesNotMatch(JSON.stringify(store.calls), /SYNTHETIC-EMBEDDING-SECRET/)
  const restarted = new KnowledgeEmbeddingProfiles(options)
  await restarted.initialize()
  assert.equal(restarted.view().version, 1)
  assert.deepEqual(await restarted.embedding().embed(['报销'], 'query'), [
    [1, 0],
  ])
})

test('failed candidate indexing preserves active profile and optimistic version protects concurrent writes', async (t) => {
  const { profiles, input, store } = await fixture(t)
  const initial = profiles.embedding()
  await assert.rejects(
    profiles.save(
      'admin',
      input,
      {
        index: async () => {
          throw new Error('Synthetic index failure')
        },
      },
      AbortSignal.timeout(5000),
    ),
    /Synthetic index failure/,
  )
  assert.equal(profiles.embedding(), initial)
  assert.equal(profiles.view().version, 0)
  assert.equal(store.stored(), null)
  await profiles.save(
    'admin',
    input,
    { index: async () => {} },
    AbortSignal.timeout(5000),
  )
  await assert.rejects(
    profiles.save(
      'admin',
      input,
      {
        index: async () =>
          assert.fail('Must reject stale configuration before indexing'),
      },
      AbortSignal.timeout(5000),
    ),
    /设置已更新/,
  )
})

test('same-origin key retention works and model revision changes rebuild through an isolated provider', async (t) => {
  const { profiles, input } = await fixture(t)
  await profiles.save(
    'admin',
    input,
    { index: async () => {} },
    AbortSignal.timeout(5000),
  )
  const { apiKey: _secret, ...edit } = input
  let stagedRevision
  await profiles.save(
    'admin',
    { ...edit, version: 1, revision: 'r2' },
    {
      index: async (_owner, _rows, _signal, _force, candidate) => {
        stagedRevision = candidate.profile.revision
        assert.equal(profiles.embedding().profile.revision, 'r1')
      },
    },
    AbortSignal.timeout(5000),
  )
  assert.equal(stagedRevision, 'r2')
  assert.equal(profiles.view().profile.apiKeyConfigured, true)
  assert.equal(profiles.embedding().profile.revision, 'r2')
})

test('configuration rejects invalid protocols, unknown fields and noninteger vector dimensions', async (t) => {
  const { profiles, input } = await fixture(t)
  const index = {
    index: async () => assert.fail('Invalid profiles must not index'),
  }
  for (const body of [
    { ...input, baseUrl: 'file:///tmp/secret' },
    { ...input, arbitraryScript: 'danger' },
    { ...input, dimensions: 1.2 },
    { ...input, baseUrl: 'https://user:secret@example.com' },
  ]) {
    await assert.rejects(
      profiles.save('admin', body, index, AbortSignal.timeout(5000)),
      (error) => error.status === 422,
    )
  }
})

test('models.manage alone cannot export knowledge or change its embedding provider', async (t) => {
  const { profiles, input, options, requests, store } = await fixture(t)
  options.getAccount = async () => ({
    permissions: ['models.manage'],
    disabled: false,
  })
  await assert.rejects(
    profiles.save(
      'models-only',
      input,
      { index: async () => assert.fail('Must not read or export knowledge') },
      AbortSignal.timeout(5000),
    ),
    (error) => error.status === 403 && /agents.manage/u.test(error.message),
  )
  assert.equal(requests.length, 0)
  assert.equal(store.stored(), null)
})

test('the SSRF origin allowlist cannot authorize data export and browser inputs cannot grant trust', async (t) => {
  const { profiles, input, options, requests, store } = await fixture(t)
  options.trustedOrigins = ''
  const index = {
    index: async () =>
      assert.fail('Untrusted endpoint must receive no company data'),
  }
  await assert.rejects(
    profiles.save('admin', input, index, AbortSignal.timeout(5000)),
    (error) => error.status === 403 && /资料外发许可/u.test(error.message),
  )
  await assert.rejects(
    profiles.save(
      'admin',
      { ...input, trustedOrigins: input.baseUrl },
      index,
      AbortSignal.timeout(5000),
    ),
    (error) => error.status === 422,
  )
  assert.equal(requests.length, 0)
  assert.equal(store.stored(), null)
})

test('removing deployment trust blocks saved external profiles without preventing platform initialization', async (t) => {
  const { profiles, input, options, requests } = await fixture(t)
  await profiles.save(
    'admin',
    input,
    { index: async () => {} },
    AbortSignal.timeout(5000),
  )
  const count = requests.length
  const restarted = new KnowledgeEmbeddingProfiles({
    ...options,
    trustedOrigins: '',
  })
  await restarted.initialize()
  await assert.rejects(
    restarted.embedding().embed(['COMPANY-PRIVATE-DOCUMENT'], 'document'),
    (error) => error.status === 403,
  )
  assert.equal(requests.length, count)
})

test('permission revocation during index preparation prevents activating and persisting the candidate', async (t) => {
  const { profiles, input, options, store } = await fixture(t)
  const current = profiles.embedding()
  await assert.rejects(
    profiles.save(
      'admin',
      input,
      {
        index: async () => {
          options.getAccount = async () => ({
            permissions: [],
            disabled: false,
          })
        },
      },
      AbortSignal.timeout(5000),
    ),
    (error) => error.status === 403,
  )
  assert.equal(store.stored(), null)
  assert.equal(profiles.embedding(), current)
})
