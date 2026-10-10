import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientModuleSystem } from '../src/compatibility/harness/modules/system.ts'
import { ClientEntries } from '../src/compatibility/harness/modules/entries.ts'
import { admitManifest } from '../src/compatibility/harness/modules/admission.ts'
import { ProductNavigation } from '../src/app/navigation.ts'

const row = (id, inject = [], external = []) => ({
  id,
  url: `/??${id}/client.js&rev=1`,
  initialUrl: '/??batch&rev=1',
  rev: '1',
  inject,
  external,
})
const manifest = (...rows) => ({
  rev: '1',
  modules: rows,
  plugins: rows.map((value) => ({
    id: value.id,
    inject: value.inject,
    immediately: false,
  })),
})

test('product admission rejects undeclared dependencies instead of importing a compatibility plugin', () => {
  const source = manifest(row('owned', ['third-party']), row('third-party'))
  assert.throws(
    () => admitManifest(source, (id) => id === 'owned', new Set()),
    /compatibility-only module third-party/,
  )
  assert.equal(admitManifest(source, undefined, new Set()), source)
})

test('registered third-party factories stay inert in product mode, including direct imports and requires', async () => {
  let executions = 0
  const build = (product) => {
    const target = {
      mode: 'queue',
      pendingQueue: [
        {
          id: 'third-party',
          factory: () => {
            executions++
            return { marker: true }
          },
        },
        {
          id: 'owned',
          factory: (require) => ({
            requestThirdParty: () => require('third-party'),
          }),
        },
      ],
      load() {},
    }
    return new ClientModuleSystem({
      manifest: manifest(row('bootstrap'), row('owned'), row('third-party')),
      staticModules: { react: { identity: 'single-static-module' } },
      registrationTarget: target,
      bootstrapModule: { id: 'bootstrap', exports: {} },
      ...(product ? { allowModule: (id) => id !== 'third-party' } : {}),
    })
  }
  const product = build(true)
  assert.deepEqual(
    product.manifest.plugins.map((value) => value.id),
    ['bootstrap', 'owned'],
  )
  await assert.rejects(product.import('third-party'), /compatibility document/)
  const owned = await product.import('owned')
  assert.throws(() => owned.requestThirdParty(), /compatibility document/)
  assert.equal(executions, 0)
  const compatibility = build(false)
  assert.deepEqual(await compatibility.import('third-party'), { marker: true })
  assert.equal(executions, 1)
})

test('live Host graph sync reapplies admission before creating or updating Loader entries', async () => {
  let updated
  const empty = manifest()
  const entries = new ClientEntries(
    { manifest: empty },
    {
      admit: (value) => admitManifest(value, () => false, new Set()),
      update: (value) => {
        updated = value
      },
      invalidateForReplacement() {},
      prune() {},
    },
  )
  const loader = {
    ctx: { effect: () => () => {} },
    await: async () => {},
    entries: () => [],
    create: () => {
      throw new Error('Untrusted entry was created')
    },
  }
  await entries.start(loader, empty)
  await entries.sync({
    rev: 'new',
    entries: [
      { id: 'third-party', url: '/??third-party/client.js&rev=2', rev: '2' },
    ],
    batches: [
      {
        phase: 'application',
        url: '/??batch&rev=2',
        rev: '2',
        entries: ['third-party'],
      },
    ],
  })
  assert.deepEqual(updated.plugins, [])
  assert.deepEqual(updated.modules, [])
})

test('product navigation owns selection and cancels obsolete navigation while adapters can detach', () => {
  const navigation = new ProductNavigation(),
    selected = []
  const disconnect = navigation.connect({
    hasPanel: (id) => id === 'plugins',
    selectPanel: (id) => selected.push(id),
  })
  const pending = navigation.beginNavigation()
  navigation.navigate('plugins')
  assert.equal(pending.aborted, true)
  assert.equal(navigation.getSnapshot(), 'plugins')
  assert.deepEqual(selected, [null, 'plugins'])
  assert.throws(() => navigation.navigate('unknown'), /Unknown product panel/)
  assert.equal(navigation.getSnapshot(), 'plugins')
  disconnect()
  assert.throws(() => navigation.navigate(null), /not ready/)
})
