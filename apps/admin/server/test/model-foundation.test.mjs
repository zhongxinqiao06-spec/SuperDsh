import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { withTestDatabase } from './support/database.mjs'
import { IdentityService } from '../identity/service.ts'
import { ModelService } from '../models/model-service.ts'
import { ModelConfigurationService } from '../models/configuration-service.ts'
import { ModelCapabilityService } from '../models/capability-service.ts'
import { StorageRegistry } from '../files/storage-registry.ts'
import { FileLibrary } from '../files/file-library.ts'
import { validateModelParameters } from '../models/capabilities.ts'
import { ExtensionService } from '../extensions/service.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { AgentResourceService } from '../agents/resources.ts'
import { managedToolWork } from '../agents/managed-tool.ts'
import { FileService } from '../files/service.ts'

async function setup(t) {
  const db = await withTestDatabase(t),
    key = randomBytes(32).toString('base64url')
  const identity = new IdentityService(db, {
    secret: 'isolated-model-foundation',
  })
  await identity.seedBuiltinRoles()
  const admin = await identity.createUser(
    {
      username: 'modelsadmin',
      displayName: 'Admin',
      password: 'synthetic-password',
    },
    { role: 'admin' },
  )
  const member = await identity.createUser(
    {
      username: 'modelsmember',
      displayName: 'Member',
      password: 'synthetic-password',
    },
    { role: 'member' },
  )
  const configurations = new ModelConfigurationService({
    db,
    encryptionKey: key,
  })
  const models = new ModelService({
    db,
    encryptionKey: key,
    audit: async () => {},
  })
  return { db, key, identity, admin, member, configurations, models }
}

test('legacy keys are rewrapped with original AAD; defaults, identities and personal configurations survive', async (t) => {
  const { db, models, configurations, admin, member } = await setup(t)
  const body = {
    name: 'Existing DeepSeek',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'synthetic-deepseek-key',
    models: [
      {
        modelId: 'deepseek-chat',
        name: 'DeepSeek',
        contextWindow: 131072,
        maxTokens: 8192,
        inputTypes: ['text'],
      },
    ],
  }
  const provider = await models.save(body, admin.userId, null)
  await models.setDefault(
    { providerId: provider.providerId, modelId: 'deepseek-chat' },
    admin.userId,
    null,
  )
  await models.save(body, member.userId, member.userId)
  await configurations.synchronize()
  const catalog = await configurations.configurations()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].connectionId, provider.providerId)
  assert.equal(catalog[0].parameters.contextWindow, 131072)
  const binding = await configurations.bind(member, undefined, 'chat')
  assert.equal((await configurations.resolve(member, binding)).key, body.apiKey)
  const [legacy] = await db.query(
    'SELECT key_ciphertext FROM platform_model_providers WHERE id=$1',
    [provider.providerId],
  )
  const [connection] = await db.query(
    'SELECT credential_ciphertext FROM model_connections WHERE id=$1',
    [provider.providerId],
  )
  assert.notEqual(legacy.key_ciphertext, connection.credential_ciphertext)
  const saved = await configurations.saveConfiguration(catalog[0].id, {
    ...catalog[0],
    name: 'Restricted',
    roleIds: ['admin'],
  })
  const [projected] = await db.query(
    'SELECT models_json FROM platform_model_providers WHERE id=$1',
    [provider.providerId],
  )
  assert.equal(JSON.parse(projected.models_json)[0].contextWindow, 131072)
  assert.equal(JSON.parse(projected.models_json)[0].maxTokens, 8192)
  assert.deepEqual(JSON.parse(projected.models_json)[0].inputTypes, ['text'])
  // Existing installations may already have a pre-fix configuration without a
  // contextWindow. Its editable name must not reset the retained legacy value.
  const missingWindow = { ...saved.parameters }
  delete missingWindow.contextWindow
  const renamed = await configurations.saveConfiguration(saved.id, {
    ...saved,
    name: 'Renamed legacy model',
    parameters: missingWindow,
  })
  const [retained] = await db.query(
    'SELECT models_json FROM platform_model_providers WHERE id=$1',
    [provider.providerId],
  )
  assert.equal(JSON.parse(retained.models_json)[0].contextWindow, 131072)
  assert.deepEqual(JSON.parse(retained.models_json)[0].inputTypes, ['text'])
  assert.equal(renamed.parameters.contextWindow, undefined)
  await assert.rejects(configurations.resolve(member, binding), /角色/)
  assert.equal(
    (
      await configurations.resolve(admin, {
        ...binding,
        revision: saved.revision,
      })
    ).key,
    body.apiKey,
  )
  await configurations.synchronize()
  assert.equal((await configurations.configurations()).length, 1)
  assert.equal((await models.list(member.userId)).length, 1)
  await assert.rejects(
    configurations.saveConfiguration(saved.id, { ...saved, revision: 1 }),
    /已修改/,
  )
})

test('Ark image generation uses frozen configuration, transfers URL results and never repeats a paid submission', async (t) => {
  const { db, key, identity, admin, member, configurations } = await setup(t)
  const root = await mkdtemp(join(tmpdir(), 'superdsh-model-test-'))
  const registry = new StorageRegistry({
    db,
    root,
    encryptionKey: key,
    environment: {},
  })
  const files = new FileLibrary({
    db,
    registry,
    stagingDirectory: join(root, 'staging'),
  })
  t.after(async () => {
    registry.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cH2sAAAAASUVORK5CYII=',
    'base64',
  )
  let submitted = 0,
    observed
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/media')) {
      assert.equal(req.headers.authorization, undefined)
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(png)
      return
    }
    submitted++
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    observed = JSON.parse(Buffer.concat(chunks).toString())
    if (observed.prompt === 'uncertain') {
      res.destroy()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'x-request-id': 'synthetic-request',
    })
    if (
      req.url === '/responses' &&
      JSON.stringify(observed.input).includes('truncated')
    ) {
      res.end(
        JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'length' },
          output: [{ type: 'reasoning', status: 'incomplete' }],
          usage: {
            input_tokens: 10,
            output_tokens: 4096,
            output_tokens_details: { reasoning_tokens: 4096 },
          },
        }),
      )
      return
    }
    res.end(
      JSON.stringify({
        ...(req.url === '/responses'
          ? {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '测试图片证据' }],
                },
              ],
            }
          : {}),
        data: [{ url: origin + '/media?signature=synthetic' }],
        usage: { generated_images: 1 },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const connection = await configurations.saveConnection(undefined, {
    name: 'Ark fixture',
    adapter: 'volcengine-ark',
    baseUrl: origin,
    apiKey: 'synthetic-ark-key',
  })
  const config = await configurations.saveConfiguration(undefined, {
    name: 'Image',
    connectionId: connection.id,
    capability: 'image.generate',
    modelId: 'doubao-seedream-4-5-251128',
    parameters: { size: '2K' },
  })
  await configurations.setDefault('image.generate', config.id)
  const binding = await configurations.bind(admin, undefined, 'image.generate')
  // Session IDs deliberately use the real ownership tables, not a fake string.
  const { ConnectorHub } = await import('../devices/connector-hub.ts')
  const hub = new ConnectorHub({
    database: db,
    secret: 'synthetic-hub',
    getUser: (id) => identity.getUser(id),
  })
  const { connector } = await hub.store.createConnector(admin.userId, {
    name: 'Temporary',
  })
  const connectorId = connector.id
  t.after(() => hub.close())
  const sessionId = 'session_multimodal'
  await db.query(
    "INSERT INTO sessions(id,connector_id,runtime,runtime_id,status,takeover,seq,updated_seq,created_at,updated_at) VALUES($1,$2,'dsh','dsh','idle',1,1,1,$3,$3)",
    [sessionId, connectorId, new Date().toISOString()],
  )
  const service = new ModelCapabilityService({
    db,
    models: configurations,
    files,
    getAccount: (id) => identity.getUser(id),
    authorizeSession: async (owner) => {
      if (owner !== admin.userId) throw new Error('owner mismatch')
    },
    allowedOrigins: origin,
  })
  const input = { title: '脱敏配图', prompt: 'A synthetic diagram' }
  const result = await service.execute(
    admin.userId,
    sessionId,
    binding,
    'one',
    input,
    [],
    new AbortController().signal,
  )
  assert.equal(observed.model, config.modelId)
  assert.equal(observed.size, '2K')
  assert.equal(
    (await files.readBuffer(admin.userId, result.fileId)).content.equals(png),
    true,
  )
  assert.equal(
    (
      await service.execute(
        admin.userId,
        sessionId,
        binding,
        'one',
        input,
        [],
        new AbortController().signal,
      )
    ).fileId,
    result.fileId,
  )
  assert.equal(submitted, 1)
  const originalSave = files.saveLegacy.bind(files)
  files.saveLegacy = async () => {
    throw new Error('synthetic storage interruption')
  }
  await assert.rejects(
    service.execute(
      admin.userId,
      sessionId,
      binding,
      'recover',
      input,
      [],
      new AbortController().signal,
    ),
    /storage interruption/,
  )
  assert.equal(submitted, 2)
  const [pending] = await db.query(
    "SELECT state,receipt_ciphertext FROM model_provider_operations WHERE idempotency_key='recover'",
  )
  assert.equal(pending.state, 'result-pending')
  assert.doesNotMatch(pending.receipt_ciphertext, /signature=synthetic/)
  files.saveLegacy = originalSave
  const recovered = await service.execute(
    admin.userId,
    sessionId,
    binding,
    'recover',
    input,
    [],
    new AbortController().signal,
  )
  assert.ok(recovered.fileId)
  assert.equal(
    submitted,
    2,
    'recover the accepted result without another paid generation',
  )
  await assert.rejects(
    service.execute(
      admin.userId,
      sessionId,
      binding,
      'one',
      { ...input, prompt: 'changed' },
      [],
      new AbortController().signal,
    ),
    /不同内容/,
  )
  await assert.rejects(files.entry(member.userId, result.fileId), /无权/)
  await service.execute(
    admin.userId,
    sessionId,
    binding,
    'reference-edit',
    input,
    [{ content: png, mediaType: 'image/png' }],
    new AbortController().signal,
  )
  assert.match(observed.image, /^data:image\/png;base64,/)
  const vision = await configurations.saveConfiguration(undefined, {
    name: 'Vision',
    connectionId: connection.id,
    capability: 'vision.analyze',
    modelId: 'ep-vision',
    parameters: {},
  })
  const visionBinding = await configurations.bind(
    admin,
    vision.id,
    'vision.analyze',
  )
  assert.equal(
    (
      await service.execute(
        admin.userId,
        sessionId,
        visionBinding,
        'vision',
        { prompt: '检查配图' },
        [{ content: png, mediaType: 'image/png' }],
        new AbortController().signal,
      )
    ).text,
    '测试图片证据',
  )
  assert.equal(observed.store, false)
  assert.deepEqual(observed.thinking, { type: 'disabled' })
  const truncated = () =>
    service.execute(
      admin.userId,
      sessionId,
      visionBinding,
      'truncated',
      { prompt: 'truncated' },
      [{ content: png, mediaType: 'image/png' }],
      new AbortController().signal,
    )
  await assert.rejects(truncated(), /推理也占用输出额度/)
  const submittedBeforeReplay = submitted
  const [incomplete] = await db.query(
    "SELECT state,error,usage_json FROM model_provider_operations WHERE idempotency_key='truncated'",
  )
  assert.equal(incomplete.state, 'failed')
  assert.match(incomplete.error, /输出上限/)
  assert.equal(JSON.parse(incomplete.usage_json).output_tokens, 4096)
  await assert.rejects(truncated(), /推理也占用输出额度/)
  assert.equal(
    submitted,
    submittedBeforeReplay,
    'an incomplete paid result is not submitted again',
  )
  const uncertain = () =>
    service.execute(
      admin.userId,
      sessionId,
      binding,
      'uncertain',
      { prompt: 'uncertain' },
      [],
      new AbortController().signal,
    )
  await assert.rejects(uncertain())
  const submissions = submitted
  await assert.rejects(uncertain(), /不会自动重复/)
  assert.equal(submitted, submissions)
  // A copied tool gets its own resource ID; capability binding follows its
  // registered implementation instead of relying on a builtin resource name.
  const legacyFiles = new FileService(hub, join(root, 'legacy'), {})
  legacyFiles.library = files
  t.after(() => legacyFiles.close())
  const extensions = new ExtensionService({
    db,
    encryptionKey: key,
    directory: join(root, 'extensions'),
    allowedOrigins: origin,
    audit: identity.audit.bind(identity),
  })
  const agents = new BusinessAgentService({
    db,
    hub,
    files: legacyFiles,
    extensions,
    modelConfigurations: configurations,
    capabilities: service,
    audit: identity.audit.bind(identity),
    getAccount: identity.getUser.bind(identity),
  })
  const resources = new AgentResourceService(agents.options)
  const tool = await resources.saveTool(admin, {
    name: '企业配图工具副本',
    description: 'Copied configured image tool',
    enabled: true,
    implementation: {
      sourceId: 'superdsh.office',
      version: '2.1.0',
      toolId: 'image_generate',
    },
    settings: { modelConfigurationId: config.id },
  })
  assert.notEqual(tool.id, 'image_generate')
  const agent = await agents.save(admin, {
    name: '自定义配图助手',
    description: 'Synthetic copied tool',
    instructions: 'Only use the configured image tool.',
    knowledgeBaseIds: [],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [],
    toolIds: [tool.id],
    published: true,
  })
  await db.query(
    "UPDATE connectors SET executor_kind='server-agent' WHERE id=$1",
    [connectorId],
  )
  await agents.bind(
    admin,
    await hub.store.session(sessionId, admin.userId),
    agent,
  )
  const agentBinding = await agents.binding(admin.userId, sessionId)
  assert.equal(
    agentBinding.capabilityBindings[tool.id].configurationId,
    config.id,
  )
  const prepared = await managedToolWork(
    agents,
    admin.userId,
    agentBinding,
    tool.id,
    'prepare',
    [],
    input,
    new AbortController().signal,
  )
  const generated = await managedToolWork(
    agents,
    admin.userId,
    agentBinding,
    tool.id,
    'generate',
    [],
    prepared.document,
    new AbortController().signal,
    'copied-tool',
  )
  assert.deepEqual(generated.content, png)
  assert.equal(submitted, submissions + 1)
  await configurations.saveConfiguration(config.id, {
    ...config,
    enabled: false,
  })
  await assert.rejects(
    service.execute(
      admin.userId,
      sessionId,
      binding,
      'two',
      input,
      [],
      new AbortController().signal,
    ),
    /停用/,
  )
})

test('capability declarations reject unavailable services and unsupported model parameters', () => {
  assert.throws(
    () =>
      validateModelParameters(
        'volcengine-speech',
        'speech.synthesize',
        'speech',
        {},
      ),
    /尚未/,
  )
  assert.throws(() =>
    validateModelParameters('volcengine-ark', 'image.generate', 'seedream', {
      arbitraryEndpoint: 'http://invalid',
    }),
  )
  assert.throws(() =>
    validateModelParameters('volcengine-ark', 'image.generate', 'seedream', {
      size: '99999x10',
    }),
  )
})
