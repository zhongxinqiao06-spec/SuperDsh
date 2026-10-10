import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  ManagedModelsService,
  platformModelProfiles,
  type Catalog,
} from '../src/managed-models.ts'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
it('creates independent immutable public PiAi routes without editable credentials or remote URLs', () => {
  const catalog = {
    scope: 'a'.repeat(64),
    providers: [
      {
        providerId: 'team',
        name: 'Team',
        protocol: 'openai-completions',
        models: [
          {
            modelId: 'test',
            name: 'Test',
            contextWindow: 8192,
            maxTokens: 2048,
            inputTypes: ['text', 'image'],
          },
        ],
      },
    ],
  }
  const first = platformModelProfiles(catalog, 'http://127.0.0.1:4321')
  const route = first.get(`superdsh-${catalog.scope}-team`)!
  expect(route.apiKeyEnv).toBeUndefined()
  expect(route.baseURL).toBe(
    `http://127.0.0.1:4321/scopes/${catalog.scope}/providers/team/openai-completions`,
  )
  expect(route.piProvider!.getModels()[0]).toMatchObject({
    id: 'test',
    input: ['text', 'image'],
  })
  catalog.providers[0]!.models[0]!.name = 'Changed'
  expect(route.piProvider!.getModels()[0]!.name).toBe('Test')
  expect(
    platformModelProfiles(
      {
        scope: catalog.scope,
        providers: [{ ...catalog.providers[0]!, providerId: '../escape' }],
      },
      'http://127.0.0.1:4321',
    ).size,
  ).toBe(0)
})

it('replaces model routes in the same Host on login, account change and logout without saving a personal default', async () => {
  const ctx = new Context()
  const replace = vi.fn()
  const dispose = vi.fn()
  const handle = Object.assign(dispose, { replace })
  const registerAdapter = vi.fn(() => handle)
  const saveSelection = vi.fn()
  ctx.provide('llm', { registerAdapter } as unknown as Context['llm'])
  ctx.provide('agentDefaultModel', {
    saveSelection,
  } as unknown as Context['agentDefaultModel'])
  let catalog: Catalog = { scope: null, default: null, providers: [] }
  const original = process.env.SUPERDSH_MODEL_GATEWAY
  process.env.SUPERDSH_MODEL_GATEWAY = JSON.stringify({
    origin: 'http://127.0.0.1:9876',
    secret: 'test-only',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(catalog))),
  )
  try {
    await ctx.plugin(ManagedModelsService)
    await ctx.superdshManagedModels.refresh()
    expect(registerAdapter).not.toHaveBeenCalled()
    catalog = {
      scope: 'a'.repeat(64),
      default: { providerId: 'team', modelId: 'test' },
      providers: [
        {
          providerId: 'team',
          name: 'Team',
          protocol: 'openai-completions',
          models: [{ modelId: 'test', name: 'Test' }],
        },
      ],
    }
    await ctx.superdshManagedModels.refresh()
    expect(registerAdapter).toHaveBeenCalledExactlyOnceWith(
      [`superdsh-${catalog.scope}-team`],
      expect.any(PiAiAdapter),
    )
    catalog = { ...catalog, scope: 'b'.repeat(64) }
    await ctx.superdshManagedModels.refresh()
    expect(replace).toHaveBeenLastCalledWith([`superdsh-${catalog.scope}-team`])
    catalog = { scope: null, default: null, providers: [] }
    await ctx.superdshManagedModels.refresh()
    expect(replace).toHaveBeenLastCalledWith([])
    expect(saveSelection).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    if (original === undefined) delete process.env.SUPERDSH_MODEL_GATEWAY
    else process.env.SUPERDSH_MODEL_GATEWAY = original
    vi.unstubAllGlobals()
  }
  expect(dispose).toHaveBeenCalledOnce()
})

it('streams an actual public PiAi HTTP request through the fixed product route', async () => {
  let requestPath = '',
    authorization = '',
    requestBody = ''
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? ''
    authorization = request.headers.authorization ?? ''
    for await (const chunk of request) requestBody += String(chunk)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (delta: unknown, finish_reason: string | null = null) => ({
      id: 'chat-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    })
    for (const value of [
      event({ role: 'assistant', content: 'Hello' }),
      event({ content: ' platform' }),
      event({}, 'stop'),
    ])
      response.write(`data: ${JSON.stringify(value)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const profiles = platformModelProfiles(
      {
        scope: 'a'.repeat(64),
        providers: [
          {
            providerId: 'test',
            name: 'Test',
            protocol: 'openai-completions',
            models: [{ modelId: 'test', name: 'Test' }],
          },
        ],
      },
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    )
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'local-capability',
      auth: {
        credentials: {
          read: async () => undefined,
          list: async () => [],
          modify: async () => undefined,
          delete: async () => {},
        },
        authContext: {
          env: async () => undefined,
          fileExists: async () => false,
        },
      },
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: `superdsh-${'a'.repeat(64)}-test`,
      model: 'test',
      messages: [],
    }))
      chunks.push(chunk)
    expect(requestPath).toBe(
      `/scopes/${'a'.repeat(64)}/providers/test/openai-completions/chat/completions`,
    )
    expect(authorization).toBe('Bearer local-capability')
    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'test',
      stream: true,
    })
    expect(JSON.stringify(chunks)).toContain('Hello')
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
