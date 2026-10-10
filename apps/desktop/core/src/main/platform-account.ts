/** Platform identity is independent of the one local Home and the running Host. */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { renameSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type {
  PlatformAccountState,
  PlatformJson,
  PlatformPasswordChange,
  PlatformPasswordLogin,
  PlatformUser,
} from '../contracts/platform.ts'
import {
  atomicJson,
  privateDirectory,
  readPrivateFile,
} from '../backend/private-files.ts'
import {
  accountSpaceKey,
  platformOrigin,
  type PlatformSpaces,
} from './platform-spaces.ts'

export interface PlatformSecretStore {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export interface PlatformIdentityView {
  key: string
  origin: string
  user: PlatformUser
}
export interface PlatformAccountHooks {
  /** Login is validated; returning false keeps the old identity and credentials. */
  beforeActivate?(
    previous: PlatformIdentityView | null,
    next: PlatformIdentityView | null,
  ): Promise<boolean | void>
  onActivated?(
    previous: PlatformIdentityView | null,
    next: PlatformIdentityView | null,
  ): Promise<void>
  changed?(): void
}
interface Session {
  origin: string
  user: PlatformUser
  accessToken: string
  refreshToken: string
  expiresAt: number
}
interface ActiveIdentity {
  key: string
  origin: string
  generation: number
  session: Session
  controller: AbortController
  refreshTask?: Promise<void>
  /** Same-account reauthorization must not interrupt an established model stream. */
  retiredSessions: Session[]
}
function expiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('平台未返回有效的登录有效期')
  return Date.now() + Math.min(value, 86400) * 1000
}
export function platformUser(value: unknown): PlatformUser {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid platform user')
  const user = value as Record<string, unknown>
  if (
    typeof user.userId !== 'string' ||
    !user.userId ||
    typeof user.username !== 'string' ||
    !Array.isArray(user.roles) ||
    !user.roles.every((role) => typeof role === 'string') ||
    !Array.isArray(user.permissions) ||
    !user.permissions.every((permission) => typeof permission === 'string')
  )
    throw new Error('Invalid platform user')
  return {
    userId: user.userId,
    username: user.username,
    displayName:
      typeof user.displayName === 'string' ? user.displayName : user.username,
    email: typeof user.email === 'string' ? user.email : null,
    roles: [...user.roles],
    permissions: [...user.permissions],
    authzVersion: typeof user.authzVersion === 'number' ? user.authzVersion : 0,
    resetRequired: user.resetRequired === true,
  }
}
const identityView = (session: Session): PlatformIdentityView => ({
  key: accountSpaceKey(session.origin, session.user.userId),
  origin: session.origin,
  user: {
    ...session.user,
    roles: [...session.user.roles],
    permissions: [...session.user.permissions],
  },
})
function sessionPayload(
  origin: string,
  body: Record<string, unknown>,
): Session {
  if (
    typeof body.accessToken !== 'string' ||
    !body.accessToken ||
    typeof body.refreshToken !== 'string' ||
    !body.refreshToken
  )
    throw new Error('平台未返回桌面登录凭据')
  return {
    origin,
    user: platformUser(body),
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: expiry(body.expiresIn),
  }
}
export class PlatformAccount {
  private active: ActiveIdentity | null = null
  private identityGeneration = 0
  private loginServer: Server | undefined
  private loginController: AbortController | undefined
  private loginGeneration = 0
  private phase: 'authorizing' | 'authenticating' | 'switching' | null = null
  private readonly lifetime = new AbortController()
  private activationTail: Promise<void> = Promise.resolve()
  private error: string | null = null
  private offline = false
  private readonly hooks: PlatformAccountHooks
  constructor(
    readonly spaces: PlatformSpaces,
    private readonly secrets: PlatformSecretStore,
    private readonly openBrowser: (url: string) => Promise<void>,
    hooks: PlatformAccountHooks | ((key: string | null) => Promise<void>) = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.hooks =
      typeof hooks === 'function'
        ? { onActivated: async (_previous, next) => hooks(next?.key ?? null) }
        : hooks
  }
  initialize(): void {
    const key = this.spaces.selected
    if (key === null) return
    const raw = readPrivateFile(this.file(key))
    if (raw === undefined) return
    if (!this.secrets.isEncryptionAvailable())
      throw new Error('系统凭据加密不可用，无法读取平台登录。')
    const saved = JSON.parse(raw) as { encrypted: string }
    const value = JSON.parse(
      this.secrets.decryptString(Buffer.from(saved.encrypted, 'base64')),
    ) as Session
    const next = {
      ...value,
      origin: platformOrigin(value.origin),
      user: platformUser(value.user),
    }
    if (
      accountSpaceKey(next.origin, next.user.userId) !== key ||
      typeof next.refreshToken !== 'string' ||
      typeof next.accessToken !== 'string' ||
      !Number.isFinite(next.expiresAt)
    )
      throw new Error('平台凭据与连接身份不一致')
    this.active = this.makeActive(next)
  }
  state(): PlatformAccountState {
    return {
      space: 'local',
      origin: this.active?.origin ?? null,
      user: this.active ? identityView(this.active.session).user : null,
      status:
        this.phase ??
        (this.active ? (this.offline ? 'offline' : 'ready') : 'signed-out'),
      identityKey: this.active?.key ?? null,
      identityGeneration: this.identityGeneration,
      connectorId: null,
      connectorRunning: false,
      connectorPhase: 'stopped',
      error: this.error,
      localImportAvailable: false,
    }
  }
  identity(): { key: string; generation: number } | null {
    return this.active
      ? { key: this.active.key, generation: this.active.generation }
      : null
  }
  get identityKey(): string | null {
    return this.active?.key ?? null
  }
  get origin(): string {
    return this.requireActive().origin
  }
  get user(): PlatformUser {
    return identityView(this.requireActive().session).user
  }
  private requireActive(): ActiveIdentity {
    if (!this.active) throw new Error('请登录管理平台。')
    return this.active
  }
  private makeActive(session: Session): ActiveIdentity {
    return {
      key: accountSpaceKey(session.origin, session.user.userId),
      origin: session.origin,
      generation: ++this.identityGeneration,
      session,
      controller: new AbortController(),
      retiredSessions: [],
    }
  }
  private changed(): void {
    this.hooks.changed?.()
  }
  private file(key: string): string {
    return join(this.spaces.directoryFor(key), 'account.enc.json')
  }
  private save(value: Session, destination?: string): void {
    if (!this.secrets.isEncryptionAvailable())
      throw new Error('系统凭据加密不可用，不能保存平台登录。')
    const key = accountSpaceKey(value.origin, value.user.userId)
    privateDirectory(this.spaces.directoryFor(key))
    atomicJson(destination ?? this.file(key), {
      version: 2,
      encrypted: this.secrets
        .encryptString(JSON.stringify(value))
        .toString('base64'),
    })
  }
  private async raw(
    origin: string,
    path: string,
    options: RequestInit,
  ): Promise<Response> {
    if (!/^\/(?!\/)/.test(path)) throw new Error('Invalid platform API path')
    return this.fetcher(origin + '/api/v2' + path, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(120_000),
        ...(options.signal ? [options.signal] : []),
      ]),
    })
  }
  private assertActive(active: ActiveIdentity): void {
    if (this.active !== active || active.controller.signal.aborted)
      throw new Error('平台账号已切换，此请求已取消。')
  }
  private async invalidate(active: ActiveIdentity): Promise<void> {
    if (this.active !== active) return
    active.controller.abort()
    this.active = null
    this.identityGeneration++
    this.spaces.select(null)
    this.error = '平台登录已失效，请重新登录。'
    this.offline = false
    await unlink(this.file(active.key)).catch(() => {})
    await this.hooks.onActivated?.(identityView(active.session), null)
    this.changed()
  }
  async token(): Promise<string> {
    return this.tokenFor(this.requireActive())
  }
  private async tokenFor(active: ActiveIdentity): Promise<string> {
    this.assertActive(active)
    if (active.session.expiresAt <= Date.now() + 30_000) {
      const task = (active.refreshTask ??= this.refresh(active))
      try {
        await task
      } finally {
        if (active.refreshTask === task) active.refreshTask = undefined
      }
    }
    this.assertActive(active)
    return active.session.accessToken
  }
  private async refresh(active: ActiveIdentity): Promise<void> {
    const previous = active.session
    try {
      const response = await this.raw(active.origin, '/auth/refresh', {
        method: 'POST',
        signal: active.controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: previous.refreshToken,
          clientName: 'SuperDsh Desktop',
        }),
      })
      this.assertActive(active)
      if (!response.ok) {
        await response.body?.cancel()
        const unauthorized = response.status === 401 || response.status === 403
        if (unauthorized && active.session === previous) {
          await this.invalidate(active)
        }
        throw new Error(
          unauthorized
            ? '平台登录已失效，请重新登录。'
            : '平台登录刷新暂时不可用（' + response.status + '），请稍后重试。',
        )
      }
      const next = sessionPayload(
        active.origin,
        (await response.json()) as Record<string, unknown>,
      )
      this.assertActive(active)
      if (next.user.userId !== previous.user.userId)
        throw new Error('刷新身份不一致')
      if (active.session !== previous) return
      this.save(next)
      active.session = next
      this.offline = false
      this.error = null
      this.changed()
    } catch (error) {
      if (this.active === active || this.active === null) {
        this.offline = this.active !== null
        this.error = error instanceof Error ? error.message : '平台暂时不可用'
        this.changed()
      }
      throw error
    }
  }
  /** Origin and token always come from one stable identity, including across a refresh. */
  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const active = this.requireActive()
    const token = await this.tokenFor(active)
    this.assertActive(active)
    const response = await this.raw(active.origin, path, {
      ...options,
      signal: AbortSignal.any([
        active.controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]),
      headers: {
        ...Object.fromEntries(new Headers(options.headers)),
        Authorization: 'Bearer ' + token,
      },
    })
    try {
      this.assertActive(active)
    } catch (error) {
      await response.body?.cancel()
      throw error
    }
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as { detail?: unknown }
        if (typeof body.detail === 'string') detail = body.detail.slice(0, 180)
      } catch {
        await response.body?.cancel().catch(() => {})
      }
      if (response.status === 401 && active.session.accessToken === token)
        await this.invalidate(active)
      throw new Error(
        response.status === 503
          ? '目标设备尚未连接，请检查平台连接状态后重试。'
          : response.status === 401
            ? '平台登录已失效，请重新登录。'
            : response.status === 403
              ? '账号没有此操作权限，或设备已被停用。'
              : '平台请求失败（' +
                response.status +
                '）' +
                (detail ? '：' + detail : ''),
      )
    }
    return response
  }
  async json(
    path: string,
    method = 'GET',
    body?: PlatformJson,
  ): Promise<PlatformJson> {
    const active = this.requireActive()
    const response = await this.fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    const result =
      response.status === 204 ? null : ((await response.json()) as PlatformJson)
    this.assertActive(active)
    return result
  }
  private validLogin(controller: AbortController, generation: number): boolean {
    return (
      this.loginController === controller &&
      generation === this.loginGeneration &&
      !controller.signal.aborted
    )
  }
  private async revoke(session: Session): Promise<void> {
    const response = await this.raw(session.origin, '/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.accessToken,
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    await response?.body?.cancel().catch(() => {})
  }
  private async activate(
    next: Session | null,
    controller: AbortController,
    generation: number,
    beforeCommit?: () => Promise<void>,
  ): Promise<boolean> {
    const predecessor = this.activationTail
    let release!: () => void
    this.activationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await predecessor
    try {
      if (!this.validLogin(controller, generation)) return false
      const previous = this.active
      const previousView = previous ? identityView(previous.session) : null
      const nextView = next ? identityView(next) : null
      this.phase = 'switching'
      this.changed()
      const accepted = await this.hooks.beforeActivate?.(previousView, nextView)
      if (accepted === false || !this.validLogin(controller, generation)) {
        await this.hooks.onActivated?.(previousView, previousView)
        return false
      }
      try {
        await beforeCommit?.()
      } catch (error) {
        await this.hooks.onActivated?.(previousView, previousView)
        throw error
      }
      const previousSelection = this.spaces.selected
      let stagedFile: string | undefined
      try {
        if (next) {
          const destination = this.file(nextView!.key)
          readPrivateFile(destination)
          stagedFile = destination + '.' + randomUUID() + '.pending'
          this.save(next, stagedFile)
        }
        this.spaces.select(nextView?.key ?? null)
        if (next && stagedFile) {
          renameSync(stagedFile, this.file(nextView!.key))
          stagedFile = undefined
        }
      } catch (error) {
        const failures: unknown[] = [error]
        try {
          if (this.spaces.selected !== previousSelection)
            this.spaces.select(previousSelection)
        } catch (rollbackError) {
          failures.push(rollbackError)
        }
        if (stagedFile) {
          try {
            unlinkSync(stagedFile)
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
              failures.push(cleanupError)
          }
        }
        try {
          await this.hooks.onActivated?.(previousView, previousView)
        } catch (restoreError) {
          failures.push(restoreError)
        }
        throw new AggregateError(
          failures,
          '无法保存平台登录，原账号未切换，请检查系统凭据或本地磁盘后重试。',
          { cause: error },
        )
      }
      const same = previous && next && previous.key === nextView!.key
      if (same) {
        previous.retiredSessions.push(previous.session)
        previous.session = next
      } else {
        previous?.controller.abort()
        this.active = next ? this.makeActive(next) : null
        if (!next) this.identityGeneration++
      }
      this.offline = false
      this.error = null
      this.changed()
      if (previous && !same) {
        await unlink(this.file(previous.key)).catch(() => {})
        await Promise.all(
          [previous.session, ...previous.retiredSessions].map((session) =>
            this.revoke(session),
          ),
        )
      }
      await this.hooks.onActivated?.(previousView, nextView)
      return true
    } finally {
      release()
    }
  }
  private async validateSession(
    next: Session,
    signal: AbortSignal,
  ): Promise<Session> {
    const response = await this.raw(next.origin, '/auth/me', {
      signal,
      headers: { Authorization: 'Bearer ' + next.accessToken },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('无法验证平台账号')
    }
    const user = platformUser(await response.json())
    if (user.userId !== next.user.userId) throw new Error('平台登录身份不一致')
    return { ...next, user }
  }
  async loginWithPassword(input: PlatformPasswordLogin): Promise<void> {
    if (
      !input ||
      typeof input.origin !== 'string' ||
      typeof input.identifier !== 'string' ||
      !input.identifier.trim() ||
      input.identifier.length > 320 ||
      typeof input.password !== 'string' ||
      !input.password ||
      input.password.length > 1024
    )
      throw new Error('请输入平台地址、用户名或邮箱及密码。')
    await this.cancelLogin()
    const origin = platformOrigin(input.origin.trim())
    const controller = new AbortController()
    const generation = this.loginGeneration
    this.loginController = controller
    this.phase = 'authenticating'
    this.error = null
    this.changed()
    let staged: Session | undefined
    let activated = false
    try {
      const response = await this.raw(origin, '/auth/login', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: input.identifier.trim(),
          password: input.password,
          clientType: 'native',
          clientName: 'SuperDsh Desktop',
        }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(
          response.status === 401
            ? '用户名或密码不正确。'
            : '平台登录失败（' + response.status + '）。',
        )
      }
      staged = sessionPayload(
        origin,
        (await response.json()) as Record<string, unknown>,
      )
      if (!this.validLogin(controller, generation)) return
      staged = await this.validateSession(staged, controller.signal)
      activated = await this.activate(staged, controller, generation)
    } catch (error) {
      if (this.validLogin(controller, generation)) {
        this.error = error instanceof Error ? error.message : '平台登录失败'
        this.changed()
        throw error
      }
    } finally {
      if (staged && !activated && this.active?.session !== staged)
        await this.revoke(staged)
      this.finishLogin(controller)
    }
  }
  async changePassword(input: PlatformPasswordChange): Promise<void> {
    if (
      !input ||
      typeof input.newPassword !== 'string' ||
      input.newPassword.length < 8 ||
      input.newPassword.length > 1024
    )
      throw new Error('新密码需为 8–1024 个字符。')
    const active = this.requireActive()
    await this.cancelLogin()
    const controller = new AbortController()
    const generation = this.loginGeneration
    this.loginController = controller
    try {
      await this.activate(null, controller, generation, async () => {
        this.assertActive(active)
        await this.json('/auth/change-password', 'POST', {
          newPassword: input.newPassword,
        })
      })
    } finally {
      this.finishLogin(controller)
    }
  }
  /** Browser PKCE is optional and uses exactly the same staged activation. */
  async login(value: string): Promise<void> {
    await this.cancelLogin()
    const origin = platformOrigin(value)
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const controller = new AbortController()
    const generation = this.loginGeneration
    let receivedCallback = false
    this.loginController = controller
    this.phase = 'authorizing'
    this.error = null
    this.changed()
    let redirectUri = ''
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      const received = Buffer.from(url.searchParams.get('state') ?? '')
      const expected = Buffer.from(state)
      response.setHeader('Cache-Control', 'no-store')
      if (
        request.method !== 'GET' ||
        request.headers.host !== new URL(redirectUri).host ||
        url.pathname !== '/oauth/callback' ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected) ||
        !this.validLogin(controller, generation) ||
        receivedCallback
      ) {
        response.writeHead(400).end('Invalid authorization callback')
        return
      }
      receivedCallback = true
      const code = url.searchParams.get('code')
      response
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(code ? '授权已收到，请返回 SuperDsh。' : '授权已取消。')
      server.close()
      this.loginServer = undefined
      if (!code) {
        void this.cancelLogin()
        return
      }
      void (async () => {
        let staged: Session | undefined
        let activated = false
        try {
          const response = await this.raw(origin, '/oauth/token', {
            method: 'POST',
            signal: controller.signal,
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: 'superdsh-desktop',
              redirect_uri: redirectUri,
              code,
              code_verifier: verifier,
            }),
          })
          if (!response.ok)
            throw new Error('平台授权失败（' + response.status + '）')
          const token = (await response.json()) as Record<string, unknown>
          if (
            typeof token.access_token !== 'string' ||
            typeof token.refresh_token !== 'string'
          )
            throw new Error('平台未返回桌面凭据')
          const me = await this.raw(origin, '/auth/me', {
            signal: controller.signal,
            headers: { Authorization: 'Bearer ' + token.access_token },
          })
          if (!me.ok) throw new Error('无法验证平台账号')
          staged = {
            origin,
            user: platformUser(await me.json()),
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: expiry(token.expires_in),
          }
          activated = await this.activate(staged, controller, generation)
        } catch (error) {
          if (this.validLogin(controller, generation)) {
            this.error = error instanceof Error ? error.message : '平台登录失败'
            this.changed()
          }
        } finally {
          if (staged && !activated && this.active?.session !== staged)
            await this.revoke(staged)
          this.finishLogin(controller)
        }
      })()
    })
    this.loginServer = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    redirectUri =
      'http://127.0.0.1:' +
      (server.address() as AddressInfo).port +
      '/oauth/callback'
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'superdsh-desktop',
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'profile',
      state,
    })
    const timer = setTimeout(() => {
      if (this.validLogin(controller, generation)) {
        this.error = '平台登录已超时'
        void this.cancelLogin()
      }
    }, 600_000)
    timer.unref()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), {
      once: true,
    })
    try {
      await this.openBrowser(origin + '/#/desktop-oauth?' + query)
    } catch (error) {
      await this.cancelLogin()
      throw error
    }
  }
  private finishLogin(controller: AbortController): void {
    if (this.loginController !== controller) return
    controller.abort()
    this.loginController = undefined
    this.phase = null
    this.changed()
  }
  async cancelLogin(): Promise<void> {
    this.loginGeneration++
    this.loginController?.abort()
    this.loginController = undefined
    this.phase = null
    const server = this.loginServer
    this.loginServer = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.changed()
  }
  async logout(): Promise<void> {
    await this.cancelLogin()
    const controller = new AbortController()
    const generation = this.loginGeneration
    this.loginController = controller
    try {
      await this.activate(null, controller, generation)
    } finally {
      this.finishLogin(controller)
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort()
    this.active?.controller.abort()
    await this.cancelLogin()
  }
}
