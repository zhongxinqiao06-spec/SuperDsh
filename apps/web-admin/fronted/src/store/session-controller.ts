import { apiUrl } from '@/utils/api-config'
import { responseError } from '@/utils/errors'
import type { AuthResponse, Identity } from '@/types/auth/auth'

type Listener = () => void
const deferredHeaders = { 'X-SuperDsh-Agent-Preparation': 'deferred' }
const signedOutKey = 'starbridge.signed-out'

/** 认证的内存事实源：刷新单飞，代际隔离登出/换号后的迟到结果。 */
export class SessionController {
  current: AuthResponse | null = null
  generation = 0
  private revision = 0
  private refreshing: Promise<AuthResponse | null> | null = null
  private signingOut: Promise<void> | null = null
  private signedOut = false
  private listeners = new Set<Listener>()

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** 订阅身份变化，返回显式清理函数。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 只接纳完整认证响应；同账号令牌轮换不会清空草稿。 */
  accept(response: AuthResponse): void {
    if (!response.accessToken || !response.userId)
      throw new Error('服务端返回了无效认证信息')
    if (this.current?.userId !== response.userId) this.generation++
    this.revision++
    this.signedOut = false
    try {
      sessionStorage.removeItem(signedOutKey)
    } catch {
      /* 内存代际仍保护当前文档。 */
    }
    this.current = {
      ...response,
      roles: response.roles ?? [],
      permissions: response.permissions ?? [],
    }
    this.emit()
  }

  /** 权限更新保留当前令牌，但通知界面及时卸载失去授权的模块。 */
  updateIdentity(identity: Identity): void {
    if (this.current?.userId !== identity.userId) return
    this.current = { ...this.current, ...identity }
    this.emit()
  }

  /** 清理立即使旧请求失效，包含同一账号重新登录的情况。 */
  clear(): void {
    this.generation++
    this.revision++
    this.current = null
    this.emit()
  }

  /** 多个401共享一个刷新请求；账号变化后旧响应不能写回。 */
  refresh(): Promise<AuthResponse | null> {
    if (this.signedOut) return Promise.resolve(null)
    try {
      if (sessionStorage.getItem(signedOutKey) === '1')
        return Promise.resolve(null)
    } catch {
      /* 存储不可用时继续使用内存隔离。 */
    }
    if (this.refreshing) return this.refreshing
    const revision = this.revision
    this.refreshing = (async () => {
      const response = await this.fetcher(apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...deferredHeaders, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      })
      if (revision !== this.revision) return this.current
      if (response.status === 401 || response.status === 403) {
        this.clear()
        return null
      }
      const payload: unknown = await response.json()
      if (!response.ok) throw responseError(payload, response.status)
      if (revision !== this.revision) return this.current
      this.accept(payload as AuthResponse)
      return this.current
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** 新登录等待旧Cookie操作完成，避免登出响应擦除新会话。 */
  async beforeLogin(): Promise<void> {
    await this.signingOut
    await this.refreshing?.catch(() => undefined)
  }

  /** 先封锁本地身份，再等待刷新Cookie落地后撤销服务端会话。 */
  signOut(): Promise<void> {
    if (this.signingOut) return this.signingOut
    const token = this.current?.accessToken
    const refreshing = this.refreshing
    this.signedOut = true
    try {
      sessionStorage.setItem(signedOutKey, '1')
    } catch {
      /* 存储不可用时仍立即清除本地身份。 */
    }
    this.clear()
    this.signingOut = (async () => {
      await refreshing?.catch(() => undefined)
      const response = await this.fetcher(apiUrl('/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          ...deferredHeaders,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok && response.status !== 401)
        throw responseError(await response.json(), response.status)
    })().finally(() => {
      this.signingOut = null
    })
    return this.signingOut
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 单文档共享认证实例，不将凭据写入浏览器持久存储。 */
export const sessionController = new SessionController()
