import { expect, it, vi } from 'vitest'
import {
  platformAgentBinding,
  platformAgentCreation,
  platformAgentDefinitions,
} from '../src/client/platform.ts'
import { PlatformRemote, remoteRoute } from '../src/main/platform-remote.ts'
import type { PlatformAccount } from '../src/main/platform-account.ts'

const agent = {
  id: 'agent_report',
  name: '经营分析助手',
  published: true,
  version: 3,
}

it('offers only valid published definitions, and does not use the catalog to overwrite frozen session versions', () => {
  const definitions = platformAgentDefinitions({
    items: [
      agent,
      { ...agent, id: 'draft', published: false },
      { ...agent, id: 'invalid', version: 0 },
      null,
    ],
  })
  expect(definitions.map((item) => item.id)).toEqual(['agent_report'])
  expect(
    platformAgentCreation('server-agent', '', 'agent_report', definitions),
  ).toEqual({ agentDefinitionId: 'agent_report' })
  expect(platformAgentCreation('server-agent', '', '', definitions)).toEqual({})
  expect(() =>
    platformAgentCreation('desktop', '', 'agent_report', definitions),
  ).toThrow('新建服务端会话')
  expect(() =>
    platformAgentCreation(
      'server-agent',
      'existing',
      'agent_report',
      definitions,
    ),
  ).toThrow('不可切换')
  expect(() =>
    platformAgentCreation('server-agent', '', 'removed', definitions),
  ).toThrow('不可用')
  expect(platformAgentBinding({ ...agent, version: 1 })).toEqual({
    id: agent.id,
    name: agent.name,
    version: 1,
  })
})

it('keeps the product catalog and artifact access within explicit Core API routes', () => {
  expect(remoteRoute({ operation: 'agents' })).toEqual({
    path: '/agents',
    method: 'GET',
  })
  expect(
    remoteRoute({ operation: 'agent-artifacts', sessionId: 'session' }),
  ).toEqual({ path: '/sessions/session/agent-artifacts', method: 'GET' })
  expect(
    remoteRoute({
      operation: 'download-attachment',
      sessionId: 'session',
      attachmentId: 'file_report',
    }),
  ).toEqual({
    path: '/sessions/session/attachments/file_report',
    method: 'GET',
  })
  const body = {
    connectorId: 'server',
    agentDefinitionId: agent.id,
    content: '请生成报告',
    clientMessageId: 'stable-message',
  }
  expect(remoteRoute({ operation: 'create-session', body })).toEqual({
    path: '/sessions/create-and-start',
    method: 'POST',
    body,
  })
  expect(() =>
    remoteRoute({ operation: 'download-attachment', sessionId: 'session' }),
  ).toThrow('缺少')
  expect(() =>
    remoteRoute({
      operation: 'download-attachment',
      sessionId: '..',
      attachmentId: 'file_report',
    }),
  ).toThrow('无效')
  expect(() =>
    remoteRoute({
      operation: 'agent-artifacts',
      sessionId: 'session/../../auth/me',
    }),
  ).toThrow('无效')
})

it('downloads real attachment bytes through the authenticated Core client, ignoring any supplied external URL', async () => {
  const bytes = Buffer.from('中文报告\n收入,200\n')
  const identity = { key: 'a'.repeat(64), generation: 1 }
  const account = {
    identity: () => identity,
    fetch: vi.fn(async () =>
      Response.json({
        contentBase64: bytes.toString('base64'),
        mediaType: 'text/csv',
        size: bytes.length,
        downloadUrl: 'https://untrusted.invalid/',
      }),
    ),
  }
  const remote = new PlatformRemote(
    account as unknown as PlatformAccount,
    vi.fn(),
  )
  await expect(
    remote.request({
      operation: 'download-attachment',
      sessionId: 'session',
      attachmentId: 'file_report',
      identity,
    }),
  ).resolves.toEqual({
    contentBase64: bytes.toString('base64'),
    mediaType: 'text/csv',
    size: bytes.length,
  })
  expect(account.fetch).toHaveBeenCalledWith(
    '/sessions/session/attachments/file_report',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

it('refuses malformed/oversized attachments and drops a late response after switching accounts', async () => {
  let identity = { key: 'a'.repeat(64), generation: 1 }
  const account = { identity: () => identity, fetch: vi.fn() }
  const remote = new PlatformRemote(
    account as unknown as PlatformAccount,
    vi.fn(),
  )
  const request = {
    operation: 'download-attachment' as const,
    sessionId: 'session',
    attachmentId: 'file_report',
  }
  account.fetch.mockResolvedValueOnce(
    new Response('private upstream diagnostics'),
  )
  await expect(remote.request(request)).rejects.toThrow('附件响应格式无效')
  account.fetch.mockResolvedValueOnce(
    Response.json({ contentBase64: 'invalid-base64' }),
  )
  await expect(remote.request(request)).rejects.toThrow('内容格式无效')
  account.fetch.mockResolvedValueOnce(
    Response.json({ contentBase64: 'eA==', size: 3 }),
  )
  await expect(remote.request(request)).rejects.toThrow('大小不匹配')
  account.fetch.mockResolvedValueOnce(
    new Response('', {
      headers: { 'content-length': String(64 * 1024 * 1024) },
    }),
  )
  await expect(remote.request(request)).rejects.toThrow('下载上限')
  let settle!: (value: Response) => void
  account.fetch.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      settle = resolve
    }),
  )
  const downloading = remote.request({ ...request, identity: { ...identity } })
  identity = { key: 'b'.repeat(64), generation: 2 }
  settle(Response.json({ contentBase64: 'eA==', size: 1 }))
  await expect(downloading).rejects.toThrow('账号已切换')
  const count = account.fetch.mock.calls.length
  await expect(
    remote.request({
      ...request,
      identity: { key: 'a'.repeat(64), generation: 1 },
    }),
  ).rejects.toThrow('账号已切换')
  expect(account.fetch).toHaveBeenCalledTimes(count)
})
