/** Product-owned, immutable model routes over the public Harness adapter seam. */
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  PiAiAdapter,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import {
  resolveImageAttachmentAccess,
  type AdapterRegistrationHandle,
} from '@deepseek-ai/dsh-llm'
import type { Api, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type {} from '@deepseek-ai/dsh-fs'

export const name = 'superdsh-managed-models'
export const inject = ['llm']
export interface Catalog {
  scope: string | null
  default?: { providerId: string; modelId: string } | null
  providers: {
    providerId: string
    name: string
    protocol: string
    source?: 'personal' | 'platform'
    models: {
      modelId: string
      name: string
      contextWindow?: number
      maxTokens?: number
      inputTypes?: string[]
    }[]
  }[]
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    superdshManagedModels: ManagedModelsService
  }
}
const protocols: Record<string, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}

export function platformModelProfiles(
  catalog: Catalog,
  origin: string,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  if (!catalog.scope || !/^[a-f0-9]{64}$/.test(catalog.scope)) return profiles
  for (const entry of catalog.providers) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(entry.providerId) ||
      !protocols[entry.protocol]
    )
      continue
    const provider = `superdsh-${catalog.scope}-${entry.providerId}`
    const baseUrl = `${origin}/scopes/${catalog.scope}/providers/${entry.providerId}/${entry.protocol}`
    const api = protocols[entry.protocol]!()
    const models: Model<Api>[] = entry.models.map((model) => ({
      id: model.modelId,
      name: model.name,
      provider,
      api: entry.protocol as Api,
      baseUrl,
      reasoning: false,
      input: model.inputTypes?.includes('image') ? ['text', 'image'] : ['text'],
      contextWindow: model.contextWindow ?? 32768,
      maxTokens: model.maxTokens ?? 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }))
    profiles.set(provider, {
      provider,
      displayName: `${entry.source === 'personal' ? '个人' : '平台'} · ${entry.name}`,
      api: entry.protocol,
      baseURL: baseUrl,
      piProvider: {
        id: provider,
        name: entry.name,
        baseUrl,
        auth: {
          apiKey: {
            name: 'SuperDsh',
            resolve: async ({ credential }) => ({
              auth: { apiKey: credential?.key },
              source: 'SuperDsh',
            }),
          },
        },
        getModels: () => models,
        stream: (model, context, options) =>
          api.stream(model, context, options),
        streamSimple: (model, context, options) =>
          api.streamSimple(model, context, options),
      },
      streamIdleTimeoutMs: 120000,
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 4_000_000,
      requestImageMaxBytes: 4 * 1024 * 1024,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT'],
        initialDelayMs: 500,
        maxDelayMs: 10000,
        jitterRatio: 0.1,
      },
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
    })
  }
  return profiles
}

/** One live adapter registry; refreshing identity never replaces the Host. */
export class ManagedModelsService extends Service {
  static inject = ['llm']
  private refreshTask: Promise<void> = Promise.resolve()
  private readonly update: () => Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'superdshManagedModels')
    const raw = process.env.SUPERDSH_MODEL_GATEWAY
    delete process.env.SUPERDSH_MODEL_GATEWAY
    if (!raw) throw new Error('Product model capability is unavailable')
    const gateway = JSON.parse(raw) as { origin: string; secret: string }
    const url = new URL(gateway.origin)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/' ||
      !gateway.secret
    )
      throw new Error('Invalid product model capability')
    let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map()
    let registration: AdapterRegistrationHandle | undefined
    let fingerprint = ''
    let disposed = false
    const controller = new AbortController()
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => gateway.secret,
      auth: {
        credentials: {
          read: async () => undefined,
          list: async () => [],
          modify: async () => {
            throw new Error('Platform credentials are managed by the desktop')
          },
          delete: async () => {},
        },
        authContext: {
          env: async () => undefined,
          fileExists: async () => false,
        },
      },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(
          attachments,
          (host) => ctx.get('fs')?.processPathFromHostPath(host),
          ref,
        ),
    })
    this.update = async () => {
      const response = await fetch(`${gateway.origin}/catalog`, {
        headers: { Authorization: `Bearer ${gateway.secret}` },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Platform catalog unavailable')
      const catalog = (await response.json()) as Catalog
      const nextFingerprint = JSON.stringify([catalog.scope, catalog.providers])
      if (disposed) return
      if (fingerprint !== nextFingerprint) {
        const next = platformModelProfiles(catalog, gateway.origin)
        const previous = profiles
        profiles = next
        try {
          if (registration) registration.replace([...next.keys()])
          else if (next.size)
            registration = ctx.llm.registerAdapter([...next.keys()], adapter)
        } catch (error) {
          profiles = previous
          throw error
        }
        fingerprint = nextFingerprint
      }
    }
    // A transient platform outage must not prevent the local engine from starting.
    const poll = () => void this.refresh().catch(() => {})
    poll()
    const interval = setInterval(poll, 30000)
    interval.unref()
    ctx.effect(() => () => {
      disposed = true
      controller.abort()
      clearInterval(interval)
      registration?.()
    })
  }

  refresh(): Promise<void> {
    const task = this.refreshTask.catch(() => {}).then(() => this.update())
    this.refreshTask = task
    return task
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(ManagedModelsService)
}
