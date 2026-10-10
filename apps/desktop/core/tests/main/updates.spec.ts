import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { NextUpdates, type NextUpdateOptions } from '../../src/main/updates.ts'
import { artifactRequest } from '../../src/main/update-transport.ts'
import { serveMacUpdate } from '../../src/main/mac-update-feed.ts'
import { updateAction, updateLabel } from '../../src/contracts/update-state.ts'
import type { UpdateRequest } from '../../src/platform/shared/update-checker.ts'
const configuration = {
  versionUrl: 'https://releases.example.test/version',
  downloadUrls: {
    darwin: 'https://releases.example.test/download/mac',
    win32: 'https://releases.example.test/download/windows',
  },
  allowedDownloadPrefixes: [
    'https://artifacts.example.test/superdsh/releases/',
  ],
}

const roots: string[] = []
const owners: NextUpdates[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})
async function fixture(overrides: Partial<NextUpdateOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'next-updates-test-'))
  roots.push(home)
  const artifact = Buffer.alloc(1024)
  artifact.write('koly', 512)
  const request = vi.fn<UpdateRequest>(async (url) =>
    url.includes('/version')
      ? Response.json({
          version: '2.0.15',
          channel: 'stable',
          sha256: { mac: createHash('sha256').update(artifact).digest('hex') },
        })
      : new Response(artifact, { headers: { 'content-length': '1024' } }),
  )
  const options: NextUpdateOptions = {
    userData: home,
    version: '2.0.14',
    platform: 'darwin',
    packaged: true,
    configuration,
    request,
    prepare: vi.fn(async (path) => {
      expect(await readFile(path)).toEqual(artifact)
    }),
    install: vi.fn(async () => {}),
    changed: vi.fn(),
    log: vi.fn(),
    ...overrides,
  }
  const updates = new NextUpdates(options)
  owners.push(updates)
  return { updates, options, request }
}

it('checks without downloading; download completion waits for an explicit installation', async () => {
  const { updates, options, request } = await fixture()
  await updates.check()
  expect(updates.snapshot().phase).toBe('available')
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[0]).toBe(configuration.versionUrl)
  expect(
    new Headers(request.mock.calls[0]?.[1].headers).get(
      'X-DSH-Desktop-Channel',
    ),
  ).toBe('stable')
  await Promise.all([updates.download(), updates.download()])
  expect(updates.snapshot()).toMatchObject({
    phase: 'ready',
    received: 1024,
    total: 1024,
  })
  expect(options.prepare).toHaveBeenCalledOnce()
  expect(options.install).not.toHaveBeenCalled()
  await updates.install()
  expect(options.install).toHaveBeenCalledOnce()
  expect(updates.snapshot().phase).toBe('installing')
})
it('does not confuse an unpublished channel, invalid response or network failure with up to date', async () => {
  for (const response of [
    new Response('', { status: 400 }),
    new Response('', { status: 503 }),
    Response.json({ version: '2.0.15-next.1', channel: 'next' }),
  ]) {
    const { updates } = await fixture({ request: async () => response })
    await updates.check()
    expect(updates.snapshot()).toMatchObject({
      phase: 'error',
      error: 'service',
    })
  }
})
it('allows checks in development, but never downloads or replaces the development application', async () => {
  const { updates, options, request } = await fixture({ packaged: false })
  await updates.check()
  await updates.download()
  expect(updates.snapshot()).toMatchObject({
    installable: false,
    error: 'development',
  })
  expect(request).toHaveBeenCalledOnce()
  expect(options.prepare).not.toHaveBeenCalled()
})
it('rechecks the selected version before downloading, and preserves preparation failures for retry', async () => {
  const { updates, options } = await fixture({
    prepare: async () => {
      throw new Error('Signature mismatch')
    },
  })
  await updates.download()
  expect(updates.snapshot()).toMatchObject({ phase: 'error', error: 'prepare' })
  await updates.install()
  expect(options.install).not.toHaveBeenCalled()
  expect(updateAction(updates.snapshot())).toBe('download-update')
})
it('stops polling and aborts an active request on shutdown', async () => {
  const request = vi.fn<UpdateRequest>(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      ),
  )
  const { updates } = await fixture({ request, packaged: false })
  const check = updates.check()
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
  await updates.dispose()
  await check
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
})
it('shows progress and an actionable downloaded state in both languages', () => {
  expect(
    updateLabel({ phase: 'unconfigured', installable: true }, 'zh-CN'),
  ).toContain('尚未配置')
  expect(
    updateLabel({ phase: 'unconfigured', installable: true }, 'en'),
  ).toContain('not configured')
  expect(updateAction({ phase: 'unconfigured', installable: true })).toBe(
    'check-updates',
  )
  expect(
    updateLabel(
      { phase: 'downloading', installable: true, received: 25, total: 100 },
      'zh-CN',
    ),
  ).toContain('25%')
  expect(
    updateLabel(
      { phase: 'downloading', installable: true, received: 2 * 1048576 },
      'en',
    ),
  ).toContain('2 MB')
  expect(
    updateAction({ phase: 'preparing', installable: true }),
  ).toBeUndefined()
  expect(updateAction({ phase: 'ready', installable: true })).toBe(
    'install-update',
  )
})
it('validates every redirect and drops release headers before contacting artifact storage', async () => {
  const policy = {
    endpoint: configuration.downloadUrls.darwin,
    allowedPrefixes: configuration.allowedDownloadPrefixes,
  }
  const request = vi.fn<UpdateRequest>(
    async (_url, _init) =>
      new Response(null, {
        status: 302,
        headers: {
          location:
            'https://artifacts.example.test/superdsh/releases/SuperDsh-2.0.15-universal.dmg',
        },
      }),
  )
  request.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: {
        location:
          'https://artifacts.example.test/superdsh/releases/SuperDsh-2.0.15-universal.dmg',
      },
    }),
  )
  request.mockResolvedValueOnce(new Response('artifact'))
  const result = await artifactRequest(request, policy)(policy.endpoint, {
    headers: { 'X-DSH-Desktop-Channel': 'stable' },
  })
  expect(result.finalUrl).toContain('artifacts.example.test')
  expect(
    new Headers(request.mock.calls[1]?.[1]?.headers).get(
      'X-DSH-Desktop-Channel',
    ),
  ).toBeNull()
  request.mockReset().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    }),
  )
  await expect(
    artifactRequest(request, policy)(policy.endpoint, {}),
  ).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
  request.mockReset().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: {
        location: 'https://artifacts.example.test/other-repository/update.dmg',
      },
    }),
  )
  await expect(
    artifactRequest(request, policy)(policy.endpoint, {}),
  ).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})

it('keeps unconfigured updates visible without network calls, polling or preparing an installer', async () => {
  const { updates, request, options } = await fixture({ configuration: null })
  updates.start()
  await updates.check()
  await updates.download()
  await updates.install()
  expect(updates.snapshot()).toMatchObject({ phase: 'unconfigured' })
  expect(request).not.toHaveBeenCalled()
  expect(options.prepare).not.toHaveBeenCalled()
  expect(options.install).not.toHaveBeenCalled()
})

it('permits a version-only service while reporting a missing platform download configuration', async () => {
  const { updates, request } = await fixture({
    configuration: { ...configuration, downloadUrls: {} },
  })
  await updates.check()
  expect(updates.snapshot().phase).toBe('available')
  await updates.download()
  expect(updates.snapshot().phase).toBe('unconfigured')
  expect(request).toHaveBeenCalledOnce()
})

it('refuses to download a release without its platform digest or prepare an artifact with the wrong digest', async () => {
  const missing = await fixture({
    request: async () =>
      Response.json({ version: '2.0.15', channel: 'stable' }),
  })
  await missing.updates.download()
  expect(missing.updates.snapshot()).toMatchObject({
    phase: 'error',
    error: 'integrity',
  })
  expect(missing.options.prepare).not.toHaveBeenCalled()
  const artifact = Buffer.alloc(1024)
  artifact.write('koly', 512)
  const mismatch = await fixture({
    request: async (url) =>
      url.includes('/version')
        ? Response.json({
            version: '2.0.15',
            channel: 'stable',
            sha256: { mac: '0'.repeat(64) },
          })
        : new Response(artifact),
  })
  await mismatch.updates.download()
  expect(mismatch.updates.snapshot()).toMatchObject({
    phase: 'error',
    error: 'download',
  })
  expect(mismatch.options.prepare).not.toHaveBeenCalled()
})
it('serves only the private archive to the native updater and closes its loopback listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-feed-test-'))
  roots.push(root)
  const path = join(root, 'update.zip')
  await writeFile(path, 'test archive')
  const feed = await serveMacUpdate(path, '2.0.15-next.1')
  try {
    const metadata = (await (await fetch(feed.url)).json()) as {
      url: string
      name: string
    }
    expect(metadata.name).toBe('2.0.15-next.1')
    expect(await (await fetch(metadata.url)).text()).toBe('test archive')
    expect((await fetch(new URL('/update.zip', feed.url))).status).toBe(404)
    expect((await fetch(feed.url, { method: 'POST' })).status).toBe(404)
  } finally {
    await feed.close()
  }
  await expect(fetch(feed.url)).rejects.toThrow()
})
