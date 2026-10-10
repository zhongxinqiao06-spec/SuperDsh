import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const hooks = registerSource()
const { serverAgentDefaultModel } =
  await import('../src/features/dashboard/server-agent-model.ts')
hooks.deregister()
const pair = { providerId: 'owned-provider', modelId: 'reasoning-model' }
const option = (scope, extra = {}) => {
  const provider = `superdsh-${scope.repeat(64)}-${pair.providerId}`
  const wireId =
    'dsh:model:' +
    Buffer.from(JSON.stringify([provider, pair.modelId, null])).toString(
      'base64url',
    )
  return {
    id: wireId,
    selectionId: wireId,
    displayName: 'Personal · fixture',
    default: false,
    metadata: { provider, model: pair.modelId, reasoningEffort: null },
    reasoningItems: [],
    ...extra,
  }
}

test('logical personal default maps to the actual runtime opaque ID even through another origin scope', () => {
  const target = option('b')
  assert.equal(serverAgentDefaultModel([target], pair), target)
  assert.match(target.selectionId, /^dsh:model:/)
  assert.notEqual(
    target.selectionId,
    `${target.metadata.provider}:${pair.modelId}`,
  )
})

test('missing, disabled, ambiguous and non-default reasoning variants require an explicit choice', () => {
  const target = option('a')
  assert.equal(serverAgentDefaultModel([target], null), undefined)
  assert.equal(serverAgentDefaultModel([], pair), undefined)
  assert.equal(
    serverAgentDefaultModel([option('a'), option('b')], pair),
    undefined,
  )
  assert.equal(
    serverAgentDefaultModel([option('a', { enabled: false })], pair),
    undefined,
  )
  assert.equal(
    serverAgentDefaultModel(
      [
        option('a', {
          metadata: { ...target.metadata, reasoningEffort: 'high' },
        }),
      ],
      pair,
    ),
    undefined,
  )
  assert.equal(
    serverAgentDefaultModel([option('a', { selectionId: null })], pair),
    undefined,
  )
})
