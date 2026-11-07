import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runtimeFailure,
  runtimeFailureItems,
} from '../conversations/runtime-failure.ts'

test('terminal failures expose actionable messages without leaking provider details', () => {
  for (const detail of ['length', 'max_output_tokens']) {
    assert.equal(
      runtimeFailure({ error: { message: `Response incomplete: ${detail}` } })
        .code,
      'MODEL_OUTPUT_LIMIT',
    )
  }
  const failure = runtimeFailure({
    error: { message: 'Bearer fixture-secret, provider response rejected' },
  })
  assert.equal(failure.code, 'RUNTIME_EXECUTION_FAILED')
  assert.doesNotMatch(JSON.stringify(failure), /fixture-secret|Bearer/)
})

test('replaying turn boundaries keeps deterministic failure notices and leaves successful/cancelled turns alone', () => {
  const failed = {
    id: 'turn1',
    type: 'turn.end',
    orderSeq: 4,
    content: {
      reason: {
        kind: 'error',
        error: { message: 'Response incomplete: length' },
      },
    },
  }
  const items = runtimeFailureItems([failed])
  assert.equal(items.length, 2)
  assert.equal(items[1].id, 'turn1:failure')
  assert.equal(items[1].content.code, 'MODEL_OUTPUT_LIMIT')
  assert.match(items[1].contentHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(runtimeFailureItems([failed]), items)
  for (const kind of ['completed', 'aborted', 'interrupted']) {
    const item = { ...failed, content: { reason: { kind } } }
    assert.deepEqual(runtimeFailureItems([item]), [item])
  }
})
