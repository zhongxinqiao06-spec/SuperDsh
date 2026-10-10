import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupExpiredPlatformIdentity } from '../../src/application/platform-identity-cleanup.ts'
import { PlatformAccount } from '../../src/main/platform-account.ts'
import { PlatformConnector } from '../../src/main/platform-connector.ts'
import {
  PlatformSpaces,
  accountSpaceKey,
} from '../../src/main/platform-spaces.ts'

it('allows a real Connector refresh failure to settle while retiring that same connection operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superdsh-expired-identity-test-'))
  const spaces = new PlatformSpaces(
    join(root, 'default-home'),
    join(root, 'local-home'),
  )
  const user = {
    userId: 'user-a',
    username: 'alice',
    roles: ['member'],
    permissions: ['devices.read'],
    resetRequired: false,
  }
  const key = accountSpaceKey('https://fixture.invalid', user.userId)
  spaces.select(key)
  const secrets = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  }
  await writeFile(
    join(spaces.directoryFor(key), 'account.enc.json'),
    JSON.stringify({
      encrypted: Buffer.from(
        JSON.stringify({
          origin: 'https://fixture.invalid',
          user,
          accessToken: 'test-only',
          refreshToken: 'test-only',
          expiresAt: 0,
        }),
      ).toString('base64'),
    }),
  )
  const invalidate = vi.fn()
  const closeRemote = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const report = vi.fn()
  const preparePython = vi.fn(async () => {
    throw new Error('Python must not start for an expired account')
  })
  const account = new PlatformAccount(
    spaces,
    secrets,
    async () => {},
    {
      onActivated: async () => {
        cleanupExpiredPlatformIdentity({
          invalidate,
          closeRemote,
          stopConnector: () => connector.stop(),
          refresh,
          report,
        })
      },
    },
    async () => new Response('{}', { status: 401 }),
  )
  account.initialize()
  const connector = new PlatformConnector(account, spaces.home, secrets, {
    preparePython,
  })
  try {
    await expect(connector.connect()).rejects.toThrow('平台登录已失效')
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(account.identity()).toBeNull()
    expect(invalidate).toHaveBeenCalledOnce()
    expect(closeRemote).toHaveBeenCalledOnce()
    expect(preparePython).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  } finally {
    await connector.stop()
    await account.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('captures old cleanup before yielding, and refreshes only after both retired resources settle', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const closed: string[] = []
  let active = 'old-owner'
  const refresh = vi.fn(async () => {})
  cleanupExpiredPlatformIdentity({
    invalidate() {},
    closeRemote: () => {
      const captured = active
      return pending.then(() => {
        closed.push(captured)
      })
    },
    stopConnector: () => {
      const captured = active
      return pending.then(() => {
        closed.push(captured)
      })
    },
    refresh,
    report: vi.fn(),
  })
  active = 'replacement-owner'
  expect(refresh).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(closed).toEqual(['old-owner', 'old-owner'])
})
