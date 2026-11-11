import { createHash } from 'node:crypto'
import { socketObservation } from './websocket.ts'
import { observe } from './observations.ts'
import { managementScenarios } from './management-scenarios.ts'
import { deviceScenarios } from './device-scenarios.ts'

interface Context {
  legacyBase: string
  canonicalBase: string
  setupToken: string
}
export interface ScenarioResult {
  id: string
  side: string
  observations: unknown
  passed: boolean
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** 合成Connector通知保留会话运行绑定，旧Store在每次摄入时都会验证该身份。 */
export function sessionMetadataUpdate(sessionId: string) {
  return {
    method: 'session.meta.upsert',
    params: {
      sessionId,
      runtime: 'controlled',
      runtimeId: 'controlled',
      title: '订阅后的更新标题',
    },
  }
}

/** 通过两套真实HTTP接口建立相同合成设备/会话，通知来自受控Connector而非真实手机。 */
export async function businessScenarios(
  context: Context,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const [side, base] of [
    ['old', context.legacyBase],
    ['new', context.canonicalBase],
  ] as const) {
    const root = '/api/v2'
    const call = (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
    ) => observe(base, root + path, method, body, token)
    const registered = await call('/auth/register', 'POST', {
      username: 'parity_admin',
      displayName: '差分管理员',
      password: 'Synthetic-parity-password!',
      setupToken: context.setupToken,
      clientType: 'native',
    })
    const token = record(registered.body).accessToken
    results.push({
      id: 'register-native',
      side,
      observations: registered,
      passed: registered.status === 200 && typeof token === 'string',
    })
    if (typeof token !== 'string') continue
    results.push(...(await managementScenarios(side, base, token)))
    results.push(...(await deviceScenarios(side, base, token)))
    // 每个读入口独立保存，不能将返回200直接称作新旧字段完全等价。
    for (const path of [
      '/auth/me',
      '/auth/sessions',
      '/admin/users',
      '/admin/roles',
      '/admin/settings',
      '/navigation',
      '/admin/menus',
      '/admin/models/providers',
      '/admin/models/configurations',
      '/admin/models/connections',
      '/admin/models/default',
      '/models/catalog',
      '/admin/storage',
      '/files',
      '/agents',
      '/admin/agents',
      '/admin/skills',
      '/admin/tools',
      '/admin/extensions',
      '/admin/knowledge-bases',
    ]) {
      const response = await call(path, 'GET', undefined, token)
      results.push({
        id: `admin-read:${path}`,
        side,
        observations: response,
        passed:
          response.status ===
          (path === '/admin/models/connections' ? 404 : 200),
      })
    }
    const created = await call(
      '/connectors',
      'POST',
      {
        name: '合成远端设备',
        connectorKind: 'desktop',
        executorKind: 'desktop',
        deviceOs: 'linux',
      },
      token,
    )
    const connector = record(record(created.body).connector)
    const connectorId = connector.id
    const credential = record(created.body).connectorToken
    results.push({
      id: 'create-connector',
      side,
      observations: created,
      passed:
        created.status === 200 &&
        typeof connectorId === 'string' &&
        typeof credential === 'string',
    })
    if (typeof connectorId !== 'string' || typeof credential !== 'string')
      continue
    const response = await fetch(`${base}${root}/connector/auth`, {
      method: 'POST',
      headers: {
        Authorization: `Connector ${connectorId}:${credential}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
    const auth = (await response.json()) as Record<string, unknown>
    const connectorToken = auth.accessToken
    results.push({
      id: 'connector-auth',
      side,
      observations: { status: response.status, body: auth },
      passed: response.status === 200 && typeof connectorToken === 'string',
    })
    if (typeof connectorToken !== 'string') continue
    const session = 'parity-session'
    const ingest = await call(
      '/connector/ingest',
      'POST',
      {
        notifications: [
          {
            method: 'session.created',
            params: {
              sessionId: session,
              runtime: 'controlled',
              runtimeId: 'controlled',
              title: '合成会话',
              status: 'idle',
            },
          },
        ],
      },
      connectorToken,
    )
    results.push({
      id: 'ingest-session',
      side,
      observations: ingest,
      passed: ingest.status === 200 && record(ingest.body).accepted === 1,
    })
    for (const scope of [{ dashboard: true }, { sessionId: session }]) {
      const ticket = await call(
        '/ws-ticket',
        'POST',
        { clientId: 'parity-native', scope },
        token,
      )
      const value = record(ticket.body).ticket
      results.push({
        id: `ticket:${'dashboard' in scope ? 'dashboard' : 'session'}`,
        side,
        observations: ticket,
        passed: ticket.status === 200 && typeof value === 'string',
      })
      if (typeof value !== 'string') continue
      const path =
        'dashboard' in scope ? '/dashboard/ws' : `/sessions/${session}/ws`
      const socket = await socketObservation(
        base,
        `${root}${path}?ticket=${encodeURIComponent(value)}`,
        'sessionId' in scope
          ? {
              frameCount: 2,
              afterFirstFrame: async () => {
                const changed = await call(
                  '/connector/ingest',
                  'POST',
                  {
                    notifications: [sessionMetadataUpdate(session)],
                  },
                  connectorToken,
                )
                if (
                  changed.status !== 200 ||
                  record(changed.body).accepted !== 1
                )
                  throw new Error('合成会话通知未接受')
              },
            }
          : {},
      )
      const first = record(socket.frames[0])
      const expected =
        'dashboard' in scope ? 'dashboard.snapshot' : 'session.subscribed'
      results.push({
        id: `ws-first-frame:${expected}`,
        side,
        observations: socket,
        passed:
          socket.status === 101 &&
          first.type === expected &&
          ('dashboard' in scope
            ? [
                'connectors',
                'projects',
                'sessions',
                'runtimes',
                'sessionPages',
                'serverTime',
              ].every((key) => key in first)
            : first.sessionId === session &&
              record(first.payload).clientId === 'parity-native' &&
              typeof first.eventId === 'string' &&
              typeof first.sequence === 'number'),
      })
      if ('sessionId' in scope) {
        const update = record(socket.frames[1])
        const sessionUpdate = record(record(update.payload).session)
        results.push({
          id: 'ws-committed-session-metadata',
          side,
          observations: update,
          passed:
            update.type === 'session.meta.updated' &&
            sessionUpdate.title === '订阅后的更新标题' &&
            sessionUpdate.updatedSeq === update.sequence,
        })
      }
      const replayed = await socketObservation(
        base,
        `${root}${path}?ticket=${encodeURIComponent(value)}`,
      )
      results.push({
        id: 'ws-ticket-single-use',
        side,
        observations: replayed,
        passed: replayed.status === 401,
      })
    }
    const content = Buffer.from('合成附件0123456789')
    const form = new FormData()
    form.append(
      'files',
      new Blob([content], { type: 'text/plain' }),
      '差分附件.txt',
    )
    const upload = await fetch(
      `${base}${root}/sessions/${session}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(15000),
      },
    )
    const uploaded = (await upload.json()) as Record<string, unknown>
    const file = record(
      Array.isArray(uploaded.attachments) ? uploaded.attachments[0] : undefined,
    )
    results.push({
      id: 'attachment-multipart',
      side,
      observations: { status: upload.status, body: uploaded },
      passed:
        upload.status === 200 &&
        file.sha256 === createHash('sha256').update(content).digest('hex'),
    })
    if (typeof file.fileId === 'string') {
      const attachment = `/sessions/${session}/attachments/${encodeURIComponent(file.fileId)}`
      const read = await call(attachment, 'GET', undefined, token)
      results.push({
        id: 'attachment-json',
        side,
        observations: read,
        passed:
          read.status === 200 &&
          record(read.body).contentBase64 === content.toString('base64'),
      })
      const opened = await fetch(`${base}${root}${attachment}/open`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      })
      const location = opened.headers.get('location')
      results.push({
        id: 'attachment-open-redirect',
        side,
        observations: {
          status: opened.status,
          correctPath: location?.startsWith(`${root}/sessions/local/`),
          credentialLeaked: location?.includes(token),
        },
        passed:
          opened.status === 302 &&
          !!location?.startsWith(`${root}/sessions/local/`) &&
          !location.includes(token),
      })
      if (opened.status === 302 && location) {
        const download = await fetch(`${base}${location}`, {
          headers: { Range: 'bytes=1-8' },
          signal: AbortSignal.timeout(10000),
        })
        const bytes = Buffer.from(await download.arrayBuffer())
        results.push({
          id: 'attachment-range',
          side,
          observations: {
            status: download.status,
            range: download.headers.get('content-range'),
            bytes: bytes.toString('base64'),
          },
          passed:
            download.status === 206 && bytes.equals(content.subarray(1, 9)),
        })
        await call('/auth/logout-all', 'POST', {}, token)
        const revoked = await fetch(`${base}${location}`, {
          signal: AbortSignal.timeout(10000),
        })
        results.push({
          id: 'attachment-after-logout',
          side,
          observations: { status: revoked.status },
          passed: revoked.status === 401,
        })
      }
    }
  }
  return results
}
