import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  accountSpaceKey,
  PlatformSpaces,
  platformOrigin,
} from '../src/main/platform-spaces.ts'
import {
  PlatformAccount,
  type PlatformAccountHooks,
  type PlatformSecretStore,
} from '../src/main/platform-account.ts'
import { accountEnvironment } from '../src/backend/platform-environment.ts'
import { remoteRoute } from '../src/main/platform-remote.ts'
const roots: string[] = []
const accounts: PlatformAccount[] = []
afterEach(async () => {
  await Promise.all(accounts.splice(0).map((account) => account.close()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const user = {
  userId: 'user-a',
  username: 'alice',
  email: null,
  displayName: 'Alice',
  roles: ['member'],
  permissions: ['devices.read'],
  authzVersion: 1,
  resetRequired: false,
}
const secrets: PlatformSecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (value) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 123)),
  decryptString: (value) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 123)).toString(),
}
async function fixture(
  fetcher: typeof fetch,
  hooks?: PlatformAccountHooks,
  secretStore = secrets,
) {
  const root = await mkdtemp(join(tmpdir(), 'superdsh-account-test-'))
  roots.push(root)
  const spaces = new PlatformSpaces(
    join(root, 'default-home'),
    join(root, 'legacy-home'),
  )
  const opened: string[] = []
  const switched = vi.fn<(key: string | null) => Promise<void>>(async () => {})
  const account = new PlatformAccount(
    spaces,
    secretStore,
    async (url) => {
      opened.push(url)
    },
    hooks ?? switched,
    fetcher,
  )
  accounts.push(account)
  return { root, spaces, opened, switched, account }
}
describe('platform account boundary', () => {
  it('keeps one local Home and scopes credentials by origin + immutable user ID', async () => {
    const { spaces } = await fixture(fetch)
    expect(spaces.home).toBe(spaces.localHome)
    expect(accountSpaceKey('https://a.example', 'user-a')).not.toBe(
      accountSpaceKey('https://b.example', 'user-a'),
    )
    expect(accountSpaceKey('https://a.example', 'user-a')).not.toBe(
      accountSpaceKey('https://a.example', 'user-b'),
    )
    expect(() => spaces.select('../legacy')).toThrow()
    spaces.select(accountSpaceKey('https://a.example', 'user-a'))
    expect(spaces.home).toBe(spaces.localHome)
    for (const origin of [
      'http://public.example',
      'https://user:secret@a.example',
      'https://a.example/path',
      'https://a.example?token=x',
    ])
      expect(() => platformOrigin(origin)).toThrow()
  })
  it('validates state, exchanges PKCE in main, encrypts tokens and publishes no secrets', async () => {
    const requests: { path: string; options?: RequestInit }[] = []
    const f = await fixture(async (input, options) => {
      const path = new URL(String(input)).pathname
      requests.push({ path, options })
      return Response.json(
        path.endsWith('/oauth/token')
          ? {
              access_token: 'secret-access',
              refresh_token: 'secret-refresh',
              expires_in: 900,
            }
          : user,
      )
    })
    await f.account.login('https://platform.example')
    expect(new URL(f.opened[0]!).hash).toMatch(/^#\/desktop-oauth\?/)
    const authorize = new URL(
      new URL(f.opened[0]!).hash.slice(1),
      'http://localhost',
    )
    expect(authorize.searchParams.get('client_id')).toBe('superdsh-desktop')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    const callback = new URL(authorize.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', 'wrong')
    expect((await fetch(callback)).status).toBe(400)
    expect(requests).toHaveLength(0)
    callback.searchParams.set('state', authorize.searchParams.get('state')!)
    expect((await fetch(callback)).status).toBe(200)
    await vi.waitFor(() => expect(f.switched).toHaveBeenCalledOnce())
    expect(
      new URLSearchParams(String(requests[0]!.options!.body)).get(
        'code_verifier',
      )!.length,
    ).toBeGreaterThanOrEqual(43)
    const saved = await readFile(
      join(
        f.spaces.root,
        accountSpaceKey('https://platform.example', user.userId),
        'account.enc.json',
      ),
      'utf8',
    )
    expect(saved).not.toContain('secret-access')
    expect(saved).not.toContain('secret-refresh')
    expect(JSON.stringify(f.account.state())).not.toContain('secret-')
    await f.account.logout()
    expect(f.switched).toHaveBeenLastCalledWith(null)
    expect(f.account.state().user).toBeNull()
  })
  it('never resurrects an account if login is cancelled during token exchange', async () => {
    let release!: (response: Response) => void
    const exchange = new Promise<Response>((resolve) => {
      release = resolve
    })
    const f = await fixture(async (input) =>
      String(input).endsWith('/oauth/token') ? exchange : Response.json(user),
    )
    await f.account.login('https://platform.example')
    const authorize = new URL(
        new URL(f.opened[0]!).hash.slice(1),
        'http://localhost',
      ),
      callback = new URL(authorize.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', authorize.searchParams.get('state')!)
    callback.searchParams.set('code', 'code')
    await fetch(callback)
    await f.account.cancelLogin()
    release(
      Response.json({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        expires_in: 900,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.switched).not.toHaveBeenCalled()
    expect(f.account.state().user).toBeNull()
  })
  it('removes ambient model credentials and refuses arbitrary remote routes', () => {
    const clean = accountEnvironment(
      {
        PATH: 'tools',
        HOME: 'legacy',
        OPENAI_API_KEY: 'secret',
        DEEPSEEK_TOKEN: 'secret',
        AWS_PROFILE: 'prod',
      },
      'isolated',
    )
    expect(clean).toEqual({
      PATH: 'tools',
      HOME: 'isolated',
      USERPROFILE: 'isolated',
    })
    expect(
      remoteRoute({ operation: 'snapshot', sessionId: '../../other' }).path,
    ).toBe('/sessions/..%2F..%2Fother/snapshot')
    expect(() => remoteRoute({ operation: 'arbitrary' } as never)).toThrow()
  })
})

function loginFetcher(
  requests: {
    url: string
    body: Record<string, unknown>
    headers: Headers
    signal?: AbortSignal | null
  }[],
): typeof fetch {
  return async (input, options) => {
    const url = String(input)
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : {}
    const headers = new Headers(options?.headers)
    requests.push({ url, body, headers, signal: options?.signal })
    const id = body.identifier === 'bob' ? 'user-b' : 'user-a'
    if (url.endsWith('/auth/login')) {
      if (body.password === 'wrong') return new Response(null, { status: 401 })
      return Response.json({
        ...user,
        userId: id,
        username: id === 'user-b' ? 'bob' : 'alice',
        accessToken: 'access-' + id,
        refreshToken: 'refresh-' + id,
        expiresIn: 900,
      })
    }
    if (url.endsWith('/auth/me')) {
      const bob = headers.get('authorization')?.includes('user-b')
      return Response.json({
        ...user,
        userId: bob ? 'user-b' : 'user-a',
        username: bob ? 'bob' : 'alice',
      })
    }
    if (url.endsWith('/auth/logout') || url.endsWith('/auth/change-password'))
      return new Response(null, { status: 204 })
    return Response.json({ ok: true })
  }
}
describe('native platform login without Home or Host changes', () => {
  it('logs in with a username and password in main, then validates before activation', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const before = vi.fn(async () => true)
    const activated = vi.fn(async () => {})
    const f = await fixture(loginFetcher(requests), {
      beforeActivate: before,
      onActivated: activated,
    })
    const home = f.spaces.home
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: ' alice ',
      password: 'test-password',
    })
    expect(requests[0]!.body).toEqual({
      identifier: 'alice',
      password: 'test-password',
      clientType: 'native',
      clientName: 'SuperDsh Desktop',
    })
    expect(requests[1]!.url).toContain('/auth/me')
    expect(before).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        origin: 'https://a.example',
        user: expect.objectContaining({ userId: 'user-a' }),
      }),
    )
    expect(activated).toHaveBeenCalledOnce()
    expect(f.opened).toEqual([])
    expect(f.account.state()).toMatchObject({
      space: 'local',
      status: 'ready',
      localImportAvailable: false,
    })
    expect(f.spaces.home).toBe(home)
    expect(JSON.stringify(f.account.state())).not.toMatch(
      /test-password|access-user|refresh-user/,
    )
  })
  it('wrong credentials never replace the old account or invoke teardown', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const before = vi.fn(async () => true)
    const f = await fixture(loginFetcher(requests), { beforeActivate: before })
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    before.mockClear()
    const identity = f.account.identity()
    await expect(
      f.account.loginWithPassword({
        origin: 'https://b.example',
        identifier: 'bob',
        password: 'wrong',
      }),
    ).rejects.toThrow('用户名或密码')
    expect(f.account.identity()).toEqual(identity)
    expect(f.account.user.userId).toBe('user-a')
    expect(before).not.toHaveBeenCalled()
    expect(
      requests.filter((request) => request.url.endsWith('/auth/logout')),
    ).toEqual([])
  })
  it('cancelling confirmed account activation discards the new login and keeps old credentials', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    let accept = true
    const f = await fixture(loginFetcher(requests), {
      beforeActivate: async () => accept,
    })
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    const identity = f.account.identity()
    accept = false
    await f.account.loginWithPassword({
      origin: 'https://b.example',
      identifier: 'bob',
      password: 'test-password',
    })
    expect(f.account.identity()).toEqual(identity)
    expect(await f.account.token()).toBe('access-user-a')
    const logout = requests.filter((request) =>
      request.url.endsWith('/auth/logout'),
    )
    expect(logout).toHaveLength(1)
    expect(logout[0]!.body.refreshToken).toBe('refresh-user-b')
    expect(f.spaces.selected).toBe(identity!.key)
  })
  it('does not send a new account token to an old origin while old refresh is awaiting', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const normal = loginFetcher(requests)
    let release!: (response: Response) => void
    const refresh = new Promise<Response>((resolve) => {
      release = resolve
    })
    const f = await fixture(async (input, options) => {
      if (String(input).endsWith('/auth/refresh')) return refresh
      const response = await normal(input, options)
      if (
        String(input).endsWith('/auth/login') &&
        String(input).startsWith('https://a.example')
      ) {
        const body = (await response.json()) as Record<string, unknown>
        return Response.json({ ...body, expiresIn: 1 })
      }
      return response
    })
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    const oldFetch = f.account
      .fetch('/models/catalog')
      .catch((error: unknown) => error)
    await Promise.resolve()
    await f.account.loginWithPassword({
      origin: 'https://b.example',
      identifier: 'bob',
      password: 'test-password',
    })
    release(
      Response.json({
        ...user,
        accessToken: 'late-a',
        refreshToken: 'late-refresh-a',
        expiresIn: 900,
      }),
    )
    expect(await oldFetch).toBeInstanceOf(Error)
    expect(
      requests.filter((request) => request.url.endsWith('/models/catalog')),
    ).toHaveLength(0)
    await f.account.fetch('/models/catalog')
    expect(requests.at(-1)!.url).toBe('https://b.example/api/v2/models/catalog')
    expect(requests.at(-1)!.headers.get('authorization')).toBe(
      'Bearer access-user-b',
    )
  })
  it('keeps the identity generation and established stream alive for same-account reauthorization', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const f = await fixture(loginFetcher(requests))
    const input = {
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    }
    await f.account.loginWithPassword(input)
    await f.account.fetch('/models/catalog')
    const signal = requests.at(-1)!.signal!
    const identity = f.account.identity()
    await f.account.loginWithPassword(input)
    expect(f.account.identity()).toEqual(identity)
    expect(signal.aborted).toBe(false)
    await f.account.logout()
    expect(signal.aborted).toBe(true)
    expect(
      requests.filter((request) => request.url.endsWith('/auth/logout')),
    ).toHaveLength(2)
  })
  it('changes a temporary password, clears revoked credentials and leaves local Home active', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const f = await fixture(loginFetcher(requests))
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    await f.account.changePassword({ newPassword: 'new-test-password' })
    expect(
      requests.find((request) => request.url.endsWith('/auth/change-password'))!
        .body,
    ).toEqual({ newPassword: 'new-test-password' })
    expect(f.account.state().status).toBe('signed-out')
    expect(f.account.identity()).toBeNull()
    expect(f.spaces.home).toBe(f.spaces.localHome)
  })
  it('does not change a password or revoke the old login when stopping a busy task is declined', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    let accept = true
    const f = await fixture(loginFetcher(requests), {
      beforeActivate: async () => accept,
    })
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    accept = false
    await f.account.changePassword({ newPassword: 'new-test-password' })
    expect(
      requests.some((request) => request.url.endsWith('/auth/change-password')),
    ).toBe(false)
    expect(
      requests.some((request) => request.url.endsWith('/auth/logout')),
    ).toBe(false)
    expect(f.account.user.userId).toBe('user-a')
  })
  it('invalidates revoked credentials immediately on authenticated HTTP 401', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const normal = loginFetcher(requests)
    const activated = vi.fn(async () => {})
    const f = await fixture(
      async (input, options) =>
        String(input).endsWith('/models/catalog')
          ? new Response(null, { status: 401 })
          : normal(input, options),
      { onActivated: activated },
    )
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    activated.mockClear()
    await expect(f.account.fetch('/models/catalog')).rejects.toThrow(
      '登录已失效',
    )
    expect(f.account.identity()).toBeNull()
    expect(f.spaces.selected).toBeNull()
    expect(activated).toHaveBeenCalledWith(
      expect.objectContaining({
        key: accountSpaceKey('https://a.example', 'user-a'),
      }),
      null,
    )
  })
  it('does not discard a newer same-account authorization after a late 401 for the old token', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const normal = loginFetcher(requests)
    let serial = 0
    let settle!: (response: Response) => void
    const catalog = new Promise<Response>((resolve) => {
      settle = resolve
    })
    const f = await fixture(async (input, options) => {
      if (String(input).endsWith('/models/catalog')) return catalog
      const response = await normal(input, options)
      if (!String(input).endsWith('/auth/login')) return response
      const body = (await response.json()) as Record<string, unknown>
      return Response.json({
        ...body,
        accessToken: 'access-user-a-' + ++serial,
      })
    })
    const input = {
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    }
    await f.account.loginWithPassword(input)
    const pending = f.account
      .fetch('/models/catalog')
      .catch((error: unknown) => error)
    await Promise.resolve()
    await f.account.loginWithPassword(input)
    settle(new Response(null, { status: 401 }))
    expect(await pending).toBeInstanceOf(Error)
    expect(f.account.user.userId).toBe('user-a')
    expect(await f.account.token()).toBe('access-user-a-2')
  })
  it('resumes old encrypted identity metadata while retaining the original local Home and old files', async () => {
    const f = await fixture(fetch)
    const key = accountSpaceKey('https://a.example', user.userId)
    await mkdir(join(f.spaces.root, key, 'home'), { recursive: true })
    await writeFile(
      join(f.spaces.root, 'selected.json'),
      JSON.stringify({ version: 1, key }),
    )
    await writeFile(
      join(f.spaces.root, key, 'home', 'keep-original.txt'),
      'retained',
    )
    await writeFile(
      join(f.spaces.root, key, 'account.enc.json'),
      JSON.stringify({
        encrypted: secrets
          .encryptString(
            JSON.stringify({
              origin: 'https://a.example',
              user,
              accessToken: 'old-access',
              refreshToken: 'old-refresh',
              expiresAt: Date.now() + 60_000,
            }),
          )
          .toString('base64'),
      }),
    )
    const spaces = new PlatformSpaces(
      join(f.root, 'default-home'),
      join(f.root, 'legacy-home'),
    )
    const account = new PlatformAccount(spaces, secrets, async () => {})
    accounts.push(account)
    account.initialize()
    expect(account.user.userId).toBe('user-a')
    expect(spaces.home).toBe(spaces.localHome)
    expect(
      await readFile(join(spaces.homeFor(key), 'keep-original.txt'), 'utf8'),
    ).toBe('retained')
  })
  it.each(['unavailable', 'encrypt-failed'] as const)(
    'restores the current connection when system credential storage is %s',
    async (failure) => {
      const requests: Parameters<typeof loginFetcher>[0] = []
      let fail = false
      const store: PlatformSecretStore = {
        ...secrets,
        isEncryptionAvailable: () => !(fail && failure === 'unavailable'),
        encryptString: (value) => {
          if (fail && failure === 'encrypt-failed')
            throw new Error('Test safeStorage failure')
          return secrets.encryptString(value)
        },
      }
      const before = vi.fn(async () => true)
      const activated = vi.fn(async () => {})
      const f = await fixture(
        loginFetcher(requests),
        { beforeActivate: before, onActivated: activated },
        store,
      )
      await f.account.loginWithPassword({
        origin: 'https://a.example',
        identifier: 'alice',
        password: 'test-password',
      })
      const identity = f.account.identity()!
      const original = await readFile(
        join(f.spaces.directoryFor(identity.key), 'account.enc.json'),
        'utf8',
      )
      fail = true
      activated.mockClear()
      before.mockClear()
      await expect(
        f.account.loginWithPassword({
          origin: 'https://b.example',
          identifier: 'bob',
          password: 'test-password',
        }),
      ).rejects.toThrow('无法保存平台登录')
      expect(before).toHaveBeenCalledOnce()
      expect(activated).toHaveBeenCalledWith(
        expect.objectContaining({ key: identity.key }),
        expect.objectContaining({ key: identity.key }),
      )
      expect(f.account.identity()).toEqual(identity)
      expect(f.spaces.selected).toBe(identity.key)
      expect(await f.account.token()).toBe('access-user-a')
      expect(
        await readFile(
          join(f.spaces.directoryFor(identity.key), 'account.enc.json'),
          'utf8',
        ),
      ).toBe(original)
      expect(
        requests
          .filter((request) => request.url.endsWith('/auth/logout'))
          .map((request) => request.body.refreshToken),
      ).toEqual(['refresh-user-b'])
      expect(
        await readdir(
          f.spaces.directoryFor(accountSpaceKey('https://b.example', 'user-b')),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        }),
      ).toEqual([])
    },
  )
  it('does not overwrite same-account credentials when selecting the login fails', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const normal = loginFetcher(requests)
    let serial = 0
    const activated = vi.fn(async () => {})
    const f = await fixture(
      async (input, options) => {
        const response = await normal(input, options)
        if (!String(input).endsWith('/auth/login')) return response
        return Response.json({
          ...((await response.json()) as Record<string, unknown>),
          accessToken: 'access-user-a-' + ++serial,
          refreshToken: 'refresh-user-a-' + serial,
        })
      },
      { onActivated: activated },
    )
    const login = {
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    }
    await f.account.loginWithPassword(login)
    const identity = f.account.identity()!
    const credentials = join(
      f.spaces.directoryFor(identity.key),
      'account.enc.json',
    )
    const original = await readFile(credentials, 'utf8')
    const select = vi.spyOn(f.spaces, 'select').mockImplementationOnce(() => {
      throw new Error('Test selected.json write failure')
    })
    activated.mockClear()
    await expect(f.account.loginWithPassword(login)).rejects.toThrow(
      '无法保存平台登录',
    )
    expect(f.account.identity()).toEqual(identity)
    expect(await f.account.token()).toBe('access-user-a-1')
    expect(await readFile(credentials, 'utf8')).toBe(original)
    expect(await readdir(f.spaces.directoryFor(identity.key))).toEqual([
      'account.enc.json',
    ])
    expect(activated).toHaveBeenCalledWith(
      expect.objectContaining({ key: identity.key }),
      expect.objectContaining({ key: identity.key }),
    )
    expect(
      requests
        .filter((request) => request.url.endsWith('/auth/logout'))
        .map((request) => request.body.refreshToken),
    ).toEqual(['refresh-user-a-2'])
    select.mockRestore()
    const resumed = new PlatformAccount(f.spaces, secrets, async () => {})
    accounts.push(resumed)
    resumed.initialize()
    expect(await resumed.token()).toBe('access-user-a-1')
  })
  it('rolls back the selected identity and restores the old connection if credential commit fails', async () => {
    const requests: Parameters<typeof loginFetcher>[0] = []
    const activated = vi.fn(async () => {})
    const f = await fixture(loginFetcher(requests), {
      onActivated: activated,
    })
    await f.account.loginWithPassword({
      origin: 'https://a.example',
      identifier: 'alice',
      password: 'test-password',
    })
    const previous = f.account.identity()!
    const nextKey = accountSpaceKey('https://b.example', 'user-b')
    const nextDirectory = f.spaces.directoryFor(nextKey)
    const select = f.spaces.select.bind(f.spaces)
    vi.spyOn(f.spaces, 'select').mockImplementation((key) => {
      select(key)
      if (key === nextKey) mkdirSync(join(nextDirectory, 'account.enc.json'))
    })
    activated.mockClear()
    await expect(
      f.account.loginWithPassword({
        origin: 'https://b.example',
        identifier: 'bob',
        password: 'test-password',
      }),
    ).rejects.toThrow('无法保存平台登录')
    expect(f.account.identity()).toEqual(previous)
    expect(f.spaces.selected).toBe(previous.key)
    expect(await f.account.token()).toBe('access-user-a')
    expect(activated).toHaveBeenCalledWith(
      expect.objectContaining({ key: previous.key }),
      expect.objectContaining({ key: previous.key }),
    )
    expect(await readdir(nextDirectory)).toEqual(['account.enc.json'])
    const selection = JSON.parse(
      await readFile(join(f.spaces.root, 'selected.json'), 'utf8'),
    ) as { key: string }
    expect(selection.key).toBe(previous.key)
    expect(f.spaces.home).toBe(f.spaces.localHome)
    expect(
      requests
        .filter((request) => request.url.endsWith('/auth/logout'))
        .map((request) => request.body.refreshToken),
    ).toEqual(['refresh-user-b'])
  })
})
