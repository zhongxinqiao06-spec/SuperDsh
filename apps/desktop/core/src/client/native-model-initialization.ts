import type {
  PlatformAccountState,
  PlatformBridge,
  PlatformJson,
} from '../contracts/platform.ts'

export interface InitialModelSelection {
  provider: string
  model: string
}
export interface NativeModelInitialization {
  phase: 'pending' | 'error'
  message: string
  scope?: string
}
export interface InitializationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const STORAGE_KEY = 'superdsh.native-model-initialization.v1'
const object = (value: PlatformJson | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

/** Only unresolved local model choices are durable; no credentials or remote histories are stored. */
export class NativeModelInitializationStore {
  private readonly states = new Map<string, NativeModelInitialization>()
  private readonly listeners = new Set<() => void>()
  private storageFailure: string | null = null
  constructor(private readonly storage?: InitializationStorage) {
    try {
      const saved = storage?.getItem(STORAGE_KEY)
      if (!saved) return
      const parsed: unknown = JSON.parse(saved)
      if (!Array.isArray(parsed)) throw new Error('模型初始化标记格式错误')
      for (const entry of parsed) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          !entry[1] ||
          typeof entry[1] !== 'object'
        )
          throw new Error('模型初始化标记格式错误')
        const value: Record<string, unknown> = entry[1]
        if (
          !['pending', 'error'].includes(String(value.phase)) ||
          typeof value.message !== 'string' ||
          (value.scope !== undefined && typeof value.scope !== 'string')
        )
          throw new Error('模型初始化标记格式错误')
        this.states.set(entry[0], {
          phase: 'error',
          message:
            value.phase === 'pending'
              ? '上次平台模型初始化尚未完成，请明确选择本次会话的模型。'
              : value.message,
          ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
        })
      }
    } catch (reason) {
      this.storageFailure = this.storageMessage(reason)
    }
  }
  get(sessionId: string): NativeModelInitialization | undefined {
    return (
      this.states.get(sessionId) ??
      (this.storageFailure
        ? { phase: 'error', message: this.storageFailure }
        : undefined)
    )
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  set(sessionId: string, value: NativeModelInitialization): boolean {
    this.states.set(sessionId, value)
    const saved = this.persist()
    if (!saved)
      this.states.set(sessionId, {
        ...value,
        phase: 'error',
        message: this.storageFailure!,
      })
    this.notify()
    return saved
  }
  clear(sessionId: string): boolean {
    const previous = this.states.get(sessionId)
    this.states.delete(sessionId)
    const saved = this.persist()
    if (!saved)
      this.states.set(sessionId, {
        ...previous,
        phase: 'error',
        message: this.storageFailure!,
      })
    this.notify()
    return saved
  }
  private persist(): boolean {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.states]))
      this.storageFailure = null
      return true
    } catch (reason) {
      this.storageFailure = this.storageMessage(reason)
      return false
    }
  }
  private storageMessage(reason: unknown): string {
    return `无法保存本机模型来源标记：${reason instanceof Error ? reason.message : String(reason)}。请修复本地存储后重新选择模型，当前会话不会自动改用个人额度。`
  }
  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
function browserStorage(): InitializationStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch (reason) {
    return {
      getItem() {
        throw reason
      },
      setItem() {
        throw reason
      },
    }
  }
}
const globalStore = globalThis as typeof globalThis & {
  __SUPERDSH_NATIVE_MODEL_INITIALIZATION__?: NativeModelInitializationStore
}
export const nativeModelInitialization =
  (globalStore.__SUPERDSH_NATIVE_MODEL_INITIALIZATION__ ??=
    new NativeModelInitializationStore(browserStorage()))

/** Only newly created native sessions call this; an explicit model choice clears a failed initialization. */
export async function initializeNativeSessionModel(
  bridge: PlatformBridge | undefined,
  frozenIdentity: PlatformAccountState | undefined,
  sessionId: string,
  select: (selection: InitialModelSelection) => Promise<void>,
): Promise<void> {
  if (!bridge || !frozenIdentity?.user) return
  if (
    !nativeModelInitialization.set(sessionId, {
      phase: 'pending',
      message: '正在准备平台默认模型…',
      scope: frozenIdentity.identityKey ?? undefined,
    })
  )
    return
  const check = async () => {
    const current = await bridge.state()
    if (
      current.identityKey !== frozenIdentity.identityKey ||
      current.identityGeneration !== frozenIdentity.identityGeneration ||
      !current.user
    )
      throw new Error('平台账号已切换，请明确选择此会话使用的模型')
  }
  try {
    await check()
    if (frozenIdentity.user.resetRequired)
      throw new Error('请先修改平台临时密码，或明确选择个人模型')
    if (
      !frozenIdentity.identityKey ||
      frozenIdentity.identityGeneration === undefined
    )
      throw new Error('平台连接身份尚未就绪')
    const catalog = object(
      await bridge.request({
        operation: 'model-catalog',
        identity: {
          key: frozenIdentity.identityKey,
          generation: frozenIdentity.identityGeneration,
        },
      }),
    )
    await check()
    if (catalog.default !== null) {
      const selected = object(catalog.default)
      if (
        typeof selected.providerId !== 'string' ||
        typeof selected.modelId !== 'string' ||
        catalog.scope !== frozenIdentity.identityKey
      )
        throw new Error('平台默认模型尚不可用，请明确选择个人模型或稍后重试')
      await select({
        provider: `superdsh-${catalog.scope}-${selected.providerId}`,
        model: selected.modelId,
      })
      await check()
    }
    nativeModelInitialization.clear(sessionId)
  } catch (reason) {
    nativeModelInitialization.set(sessionId, {
      phase: 'error',
      scope: frozenIdentity.identityKey ?? undefined,
      message: `${reason instanceof Error ? reason.message : String(reason)}。请从模型菜单选择本次会话的模型。`,
    })
  }
}
