import { afterEach, expect, it, vi } from 'vitest'
import type { PlatformAccount } from '../src/main/platform-account.ts'
import { PlatformModelGateway } from '../src/main/platform-model-gateway.ts'

const alice = { key: 'a'.repeat(64), generation: 1 }
const bob = { key: 'b'.repeat(64), generation: 2 }
const gateways: PlatformModelGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
})
async function fixture(identity: typeof alice | null = alice) {
  const account = {
    identity: vi.fn(() => identity),
    fetch: vi.fn(
      async (_path: string, _options: RequestInit = {}) =>
        new Response('data: {"stream":"ok"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  }
  const gateway = new PlatformModelGateway(
    account as unknown as PlatformAccount,
    () => 'my-device',
  )
  gateways.push(gateway)
  await gateway.start()
  return { account, gateway, descriptor: gateway.descriptor()! }
}
it('exposes only authenticated account-scoped model routes bound to this connector', async () => {
  const { account, descriptor } = await fixture()
  expect((await fetch(`${descriptor.origin}/catalog`)).status).toBe(401)
  expect(
    (
      await fetch(`${descriptor.origin}/https://attacker.example`, {
        headers: { Authorization: `Bearer ${descriptor.secret}` },
      })
    ).status,
  ).toBe(404)
  expect(account.fetch).not.toHaveBeenCalled()
  const response = await fetch(
    `${descriptor.origin}/scopes/${alice.key}/providers/my-provider/openai-completions/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.secret}` },
      body: JSON.stringify({ model: 'm', stream: true }),
    },
  )
  expect(await response.text()).toContain('"stream":"ok"')
  expect(account.fetch).toHaveBeenCalledWith(
    '/models/my-provider/openai-completions/chat/completions',
    expect.objectContaining({
      headers: expect.objectContaining({
        'X-SuperDsh-Connector-Id': 'my-device',
      }),
    }),
  )
  expect(JSON.stringify(account.fetch.mock.calls)).not.toContain(
    descriptor.secret,
  )
})
it('supports native Anthropic beta messages without forwarding the local capability', async () => {
  const { account, descriptor } = await fixture()
  const route = `${descriptor.origin}/scopes/${alice.key}/providers/my-provider/anthropic-messages/v1/messages`
  const response = await fetch(`${route}?beta=true`, {
    method: 'POST',
    headers: {
      'x-api-key': descriptor.secret,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'm', stream: true }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('stream')
  expect(account.fetch).toHaveBeenCalledWith(
    '/models/my-provider/anthropic-messages/messages',
    expect.objectContaining({
      headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
    }),
  )
  expect(JSON.stringify(account.fetch.mock.calls)).not.toContain(
    descriptor.secret,
  )
  expect(
    (
      await fetch(`${route}?beta=false`, {
        method: 'POST',
        headers: { 'x-api-key': descriptor.secret },
        body: '{}',
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await fetch(`${route}?beta=true&target=other`, {
        method: 'POST',
        headers: { 'x-api-key': descriptor.secret },
        body: '{}',
      })
    ).status,
  ).toBe(404)
})
it('rejects conflicting capabilities instead of accepting one header', async () => {
  const { account, descriptor } = await fixture()
  expect(
    (
      await fetch(`${descriptor.origin}/catalog`, {
        headers: {
          Authorization: `Bearer ${descriptor.secret}`,
          'x-api-key': 'wrong',
        },
      })
    ).status,
  ).toBe(401)
  expect(account.fetch).not.toHaveBeenCalled()
})
it('keeps the same loopback capability across sign-in and sign-out, with an empty signed-out catalog', async () => {
  const { account, gateway, descriptor } = await fixture(null)
  const headers = { Authorization: `Bearer ${descriptor.secret}` }
  expect(
    await (await fetch(`${descriptor.origin}/catalog`, { headers })).json(),
  ).toEqual({ scope: null, default: null, providers: [] })
  expect(account.fetch).not.toHaveBeenCalled()
  account.identity.mockReturnValue(alice)
  account.fetch.mockResolvedValue(
    new Response(JSON.stringify({ providers: [], default: null })),
  )
  expect(
    await (await fetch(`${descriptor.origin}/catalog`, { headers })).json(),
  ).toEqual({ scope: alice.key, default: null, providers: [] })
  gateway.invalidateIdentity()
  account.identity.mockReturnValue(null)
  expect(
    await (await fetch(`${descriptor.origin}/catalog`, { headers })).json(),
  ).toEqual({ scope: null, default: null, providers: [] })
  expect(gateway.descriptor()).toEqual(descriptor)
})
it('denies an old provider scope instead of spending from the replacement account', async () => {
  const { account, descriptor } = await fixture(bob)
  const response = await fetch(
    `${descriptor.origin}/scopes/${alice.key}/providers/my-provider/openai-completions/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.secret}` },
      body: '{}',
    },
  )
  expect(response.status).toBe(409)
  expect(account.fetch).not.toHaveBeenCalled()
})
it('aborts requests on identity replacement and rejects a late upstream response', async () => {
  const { account, gateway, descriptor } = await fixture()
  let settle!: (response: Response) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  account.fetch.mockImplementation(async () => {
    started()
    return new Promise<Response>((resolve) => {
      settle = resolve
    })
  })
  const result = fetch(
    `${descriptor.origin}/scopes/${alice.key}/providers/my-provider/openai-completions/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.secret}` },
      body: '{}',
    },
  )
  await entered
  const signal = account.fetch.mock.calls[0]![1]!.signal!
  gateway.invalidateIdentity()
  account.identity.mockReturnValue(bob)
  expect(signal.aborted).toBe(true)
  settle(new Response('old-account-output'))
  const response = await result
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain('old-account-output')
})
