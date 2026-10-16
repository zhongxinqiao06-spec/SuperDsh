import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  bridgeCatalog,
  bridgeCatalogNotification,
} from '../runtime/bridge-catalogs.ts'
import { NodeHarnessConnector } from '../runtime/node-connector.ts'

const model = {
  runtime: 'dsh',
  revision: 3,
  metadata: { failures: [], routableProviders: ['provider'] },
  models: [
    {
      id: 'dsh:model:base',
      title: '个人 · 测试模型',
      selectionId: 'dsh:model:base',
      enabled: false,
      disabledReason: '模型暂不可用',
      default: true,
      metadata: { provider: 'provider', model: 'model-id', source: 'personal' },
      reasoningItems: [
        {
          id: 'high',
          title: 'High',
          selectionId: 'dsh:model:high',
          enabled: false,
          disabledReason: '推理不可用',
          default: true,
        },
      ],
    },
  ],
}
const permission = {
  runtime: 'dsh',
  revision: 3,
  permissions: [
    {
      id: 'dsh:permission:workspace',
      title: '工作区写入',
      selectionId: 'dsh:permission:workspace',
      enabled: true,
      default: true,
      metadata: { preset: 'workspace-write' },
    },
  ],
}

test('DSH catalogs are converted to the public model and permission response contracts', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  for (const [kind, input] of [
    ['model', model],
    ['permission', permission],
  ]) {
    const bridgeSchema = JSON.parse(
      await readFile(
        new URL(
          `../../../../agents-anywhere/contracts/dsh-bridge/1.0/schemas/${kind}-catalog.schema.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    )
    const validateBridge = ajv.compile(bridgeSchema)
    assert.equal(
      validateBridge(input),
      true,
      JSON.stringify(validateBridge.errors),
    )
    const schema = JSON.parse(
      await readFile(
        new URL(
          `../../../../agents-anywhere/contracts/protocol/1.0/schemas/${kind}-catalog-response.schema.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    )
    const validate = ajv.compile(schema)
    const before = structuredClone(input)
    const catalog = bridgeCatalog(kind, input)
    assert.equal(
      validate({ catalog, serverTime: '2026-10-15T00:00:00Z' }),
      true,
      JSON.stringify(validate.errors),
    )
    assert.deepEqual(input, before)
    assert.equal(catalog.runtimeId, 'dsh')
  }
  const converted = bridgeCatalog('model', model)
  assert.equal(converted.models[0].displayName, '个人 · 测试模型')
  assert.equal(converted.models[0].selectionId, model.models[0].selectionId)
  assert.equal(converted.models[0].metadata.enabled, false)
  assert.equal(converted.models[0].metadata.disabledReason, '模型暂不可用')
  assert.equal(converted.models[0].metadata.source, 'personal')
  assert.equal(converted.models[0].default, false)
  assert.equal(converted.models[0].reasoningItems[0].displayName, 'High')
  assert.equal(converted.models[0].reasoningItems[0].metadata.enabled, false)
  assert.equal(converted.models[0].reasoningItems[0].default, false)
  const option = bridgeCatalog('permission', permission).permissions[0]
  assert.equal(option.displayName, '工作区写入')
  assert.equal(option.metadata.preset, 'workspace-write')
  assert.equal(option.metadata.enabled, true)
  assert.equal(option.default, false)
})

test('initial and streamed catalog notifications share one conversion and preserve event scope', () => {
  for (const [method, kind, input] of [
    ['catalog.model.update', 'model', model],
    ['catalog.permission.update', 'permission', permission],
  ]) {
    const event = bridgeCatalogNotification({ method, params: input })
    assert.equal(event.method, method)
    assert.deepEqual(event.params, bridgeCatalog(kind, input))
    const wrapped = bridgeCatalogNotification({
      method: 'runtime.catalog.updated',
      params: { sessionId: 'owned', catalogType: kind, catalog: input },
    })
    assert.equal(wrapped.params.sessionId, 'owned')
    assert.deepEqual(wrapped.params.catalog, bridgeCatalog(kind, input))
  }
  const untouched = {
    method: 'session.state.updated',
    params: { status: 'idle' },
  }
  assert.equal(bridgeCatalogNotification(untouched), untouched)
})

test('Node Connector uses the conversion for on-demand catalogs and sync ingestion', async () => {
  const received = []
  const connector = new NodeHarnessConnector({
    connectorId: 'owned',
    home: 'unused',
    workspace: 'unused',
    stateDirectory: 'unused',
    ingest: async (events) => received.push(...events),
    health: async () => {},
    disconnected: () => {},
  })
  connector.bridge.request = async (method) =>
    structuredClone(method === 'catalog.listModels' ? model : permission)
  try {
    for (const [method, kind, input] of [
      ['runtime.modelCatalog', 'model', model],
      ['runtime.permissionCatalog', 'permission', permission],
    ]) {
      const result = await connector.call(method, { runtimeId: 'dsh' })
      assert.deepEqual(result.catalog, bridgeCatalog(kind, input))
    }
    await connector.publish([{ method: 'catalog.model.update', params: model }])
    assert.equal(received[0].params.models[0].displayName, '个人 · 测试模型')
    assert.equal(received[0].params.models[0].metadata.enabled, false)
  } finally {
    await connector.close()
  }
})

test('malformed or public-protocol catalogs cannot silently cross the DSH boundary', () => {
  assert.throws(
    () => bridgeCatalog('model', { ...model, revision: -1 }),
    /revision/,
  )
  assert.throws(
    () => bridgeCatalog('model', { ...model, runtime: 'codex' }),
    /revision/,
  )
  assert.throws(() => bridgeCatalog('model', { ...model, models: {} }), /list/)
  assert.throws(
    () =>
      bridgeCatalog('model', {
        ...model,
        models: [
          { ...model.models[0], title: undefined, displayName: 'not DSH' },
        ],
      }),
    /title/,
  )
  assert.throws(
    () =>
      bridgeCatalog('permission', {
        ...permission,
        permissions: [{ ...permission.permissions[0], enabled: 'false' }],
      }),
    /enabled/,
  )
})
