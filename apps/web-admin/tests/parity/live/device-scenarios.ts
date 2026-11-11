import { observe } from './observations.ts'
import type { ScenarioResult } from './scenarios.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** 使用真实旧新 HTTP 验证安装身份重连、凭据代际及逐条通知确认。 */
export async function deviceScenarios(
  side: string,
  base: string,
  token: string,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  const call = (path: string, method = 'GET', body?: unknown, bearer = token) =>
    observe(base, '/api/v2' + path, method, body, bearer)
  const add = (id: string, observations: unknown, passed: boolean) =>
    results.push({ id: 'device:' + id, side, observations, passed })
  const empty = await call('/connectors')
  add(
    'read-does-not-prepare-host',
    empty,
    empty.status === 200 &&
      Array.isArray(record(empty.body).connectors) &&
      (record(empty.body).connectors as unknown[]).length === 0,
  )
  const input = {
    installationId: 'synthetic-installation',
    connectorKind: 'desktop',
    name: '初始设备',
  }
  const first = await call('/connectors', 'POST', input)
  const id = record(record(first.body).connector).id
  const credential = record(first.body).connectorToken
  add(
    'install-create',
    first,
    first.status === 200 &&
      typeof id === 'string' &&
      typeof credential === 'string' &&
      record(first.body).tokenPrefix === credential.slice(0, 12),
  )
  if (typeof id !== 'string' || typeof credential !== 'string') return results
  const second = await call('/connectors', 'POST', {
    ...input,
    name: '不能覆盖原名称',
  })
  const next = record(second.body).connectorToken
  add(
    'install-rotate-preserves-identity',
    second,
    second.status === 200 &&
      record(record(second.body).connector).id === id &&
      record(record(second.body).connector).name === input.name &&
      typeof next === 'string' &&
      next !== credential,
  )
  if (typeof next !== 'string') return results
  const exchange = async (value: string) => {
    const response = await fetch(base + '/api/v2/connector/auth', {
      method: 'POST',
      headers: { Authorization: `Connector ${id}:${value}` },
      signal: AbortSignal.timeout(10000),
    })
    return { status: response.status, body: (await response.json()) as unknown }
  }
  const stale = await exchange(credential)
  add('old-credential-revoked', stale, stale.status === 401)
  const valid = await exchange(next)
  const access = record(valid.body).accessToken
  add(
    'new-credential-authorized',
    valid,
    valid.status === 200 && typeof access === 'string',
  )
  if (typeof access !== 'string') return results
  const batch = await call(
    '/connector/ingest',
    'POST',
    {
      notifications: [
        { method: 'future.extension.notification', params: {} },
        { method: '' },
        { method: 'approval.requested', params: {} },
        { method: 'future.extension.notification', params: null },
      ],
    },
    access,
  )
  const body = record(batch.body)
  const rejected = Array.isArray(body.rejected) ? body.rejected.map(record) : []
  add(
    'batch-keeps-partial-success',
    batch,
    batch.status === 200 &&
      body.accepted === 2 &&
      rejected.length === 2 &&
      rejected[0]?.index === 1 &&
      rejected[0]?.message === 'method is required or invalid' &&
      rejected[1]?.index === 2 &&
      rejected[1]?.method === 'approval.requested' &&
      rejected[1]?.message === 'unsupported notification: approval.requested' &&
      rejected.every(
        (item) =>
          item.code === 'notification_failed' &&
          item.errorType === 'NotificationError',
      ),
  )
  const excess = await call(
    '/connector/ingest',
    'POST',
    {
      notifications: Array.from({ length: 10001 }, () => ({})),
    },
    access,
  )
  add(
    'bounded-notification-count',
    excess,
    excess.status === 413 &&
      record(excess.body).detail === 'too many notifications',
  )
  const rotated = await call(`/connectors/${id}/revoke`, 'POST', {})
  const rotatedCredential = record(rotated.body).connectorToken
  add(
    'rotate-is-not-delete',
    rotated,
    rotated.status === 200 &&
      record(record(rotated.body).connector).id === id &&
      typeof rotatedCredential === 'string' &&
      rotatedCredential !== next,
  )
  const oldAccess = await call(
    '/connector/ingest',
    'POST',
    { notifications: [] },
    access,
  )
  add('rotation-revokes-access', oldAccess, oldAccess.status === 401)
  if (typeof rotatedCredential === 'string') {
    const exchanged = await exchange(rotatedCredential)
    add('rotation-retains-device', exchanged, exchanged.status === 200)
  }
  const removed = await call(`/connectors/${id}`, 'DELETE')
  add(
    'revoke-installation',
    removed,
    removed.status === 204 && removed.body === null,
  )
  const revival = await call('/connectors', 'POST', input)
  add(
    'revoked-installation-cannot-revive',
    revival,
    revival.status === 409 &&
      record(revival.body).detail ===
        'installation was deleted; use a new installationId',
  )
  return results
}
