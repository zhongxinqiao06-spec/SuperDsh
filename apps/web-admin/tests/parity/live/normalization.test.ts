import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBoundary, normalizationSources } from './normalization.ts'
import type { Observation } from './observations.ts'

const source = await normalizationSources()
const now = Date.now()
const boundary = {
  started: now - 1000,
  finished: now + 1000,
  oldOrigin: 'http://127.0.0.1:6011',
  newOrigin: 'http://127.0.0.1:6012',
}
const response = (body: unknown): Observation => ({
  status: 200,
  mediaType: 'application/json',
  body,
})

test('规范化不能隐藏错误内容、空值或序列差异', () => {
  const old = response({ detail: 'denied', sequence: 9, value: null })
  for (const body of [
    { detail: 'allowed', sequence: 9, value: null },
    { detail: 'denied', sequence: 8, value: null },
    { detail: 'denied', sequence: 9 },
  ]) {
    const actual = response(body)
    const result = compareBoundary(
      '/api/v2/sessions/example/events',
      { old, compatibility: actual, canonical: actual },
      source,
      boundary,
    )
    assert.equal(result.equivalent, false)
    assert.deepEqual(result.rules, [])
  }
})

test('诊断版本必须来自各自元数据，时间必须处于本轮窗口', () => {
  const old = response({
    status: 'ok',
    version: source.oldVersion,
    serverTime: new Date(now).toISOString(),
  })
  const current = response({
    status: 'ok',
    version: source.newVersion,
    serverTime: new Date(now + 20).toISOString(),
  })
  assert.equal(
    compareBoundary(
      '/api/v2/health',
      { old, compatibility: current, canonical: current },
      source,
      boundary,
    ).equivalent,
    true,
  )
  for (const changed of [
    response({
      status: 'ok',
      version: 'made-up',
      serverTime: new Date(now).toISOString(),
    }),
    response({
      status: 'ok',
      version: source.newVersion,
      serverTime: new Date(now - 60000).toISOString(),
    }),
  ]) {
    const result = compareBoundary(
      '/api/v2/health',
      { old, compatibility: changed, canonical: current },
      source,
      boundary,
    )
    assert.equal(result.equivalent, false)
    assert.ok(result.errors.length)
  }
})

test('配对随机码可以映射，但有效期与六位码合同不能被放宽', () => {
  const pairing = (code: string, expires: number) =>
    response({
      pairingId: 'pair_' + code.repeat(4),
      code,
      serverTime: new Date(now).toISOString(),
      expiresAt: new Date(now + expires).toISOString(),
    })
  const old = pairing('123456', 300000),
    current = pairing('654321', 300000)
  assert.equal(
    compareBoundary(
      '/api/v2/pairing/start',
      { old, compatibility: current, canonical: current },
      source,
      boundary,
    ).equivalent,
    true,
  )
  const expired = pairing('654321', 600000)
  assert.equal(
    compareBoundary(
      '/api/v2/pairing/start',
      { old, compatibility: expired, canonical: current },
      source,
      boundary,
    ).equivalent,
    false,
  )
})
