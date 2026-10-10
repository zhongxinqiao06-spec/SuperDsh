import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  startFrontendDevelopment,
  type FrontendDevelopment,
} from '../../src/main/frontend-development.ts'

const fixtures: { root: string; watcher?: FrontendDevelopment }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.watcher?.dispose()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'superdsh-frontend-watch-'))
  const manifestPath = join(root, 'client-manifest.json')
  writeFileSync(manifestPath, '{"revision":0}')
  const item: { root: string; watcher?: FrontendDevelopment } = { root }
  fixtures.push(item)
  let revision = 0
  return {
    manifestPath,
    item,
    commit: () => {
      const temporary = join(root, 'client-manifest.json.tmp')
      writeFileSync(temporary, JSON.stringify({ revision: ++revision }))
      renameSync(temporary, manifestPath)
    },
  }
}
const settle = async (ms = 70): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

it('does not watch or access the manifest outside SUPERDSH_WATCH=1', async () => {
  const refresh = vi.fn(async () => {})
  const onError = vi.fn()
  const watcher = startFrontendDevelopment({
    manifestPath: 'missing/nonexistent/client-manifest.json',
    environment: {},
    refresh,
    onError,
  })
  await watcher.dispose()
  expect(refresh).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

it('debounces atomic manifest replacements and keeps watching later generations', async () => {
  const f = fixture(),
    refresh = vi.fn(async () => {}),
    onError = vi.fn()
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 20,
    refresh,
    onError,
  })
  f.commit()
  f.commit()
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  expect(onError).not.toHaveBeenCalled()
})

it('serializes refreshes and processes the newest build after a running refresh', async () => {
  const f = fixture(),
    first = Promise.withResolvers<void>()
  let calls = 0,
    active = 0,
    maximum = 0
  const refresh = vi.fn(async () => {
    calls++
    active++
    maximum = Math.max(maximum, active)
    if (calls === 1) await first.promise
    active--
  })
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 10,
    refresh,
    onError: (error) => {
      throw error
    },
  })
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  f.commit()
  f.commit()
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
  first.resolve()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  expect(maximum).toBe(1)
})

it('reports refresh errors and accepts the next build', async () => {
  const f = fixture(),
    failure = new Error('backend restart failed'),
    onError = vi.fn()
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined)
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 10,
    refresh,
    onError,
  })
  f.commit()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
})

it('retries a busy or starting runtime without consuming the manifest generation', async () => {
  const f = fixture(),
    onError = vi.fn()
  let ready = false,
    applied = 0
  const refresh = vi.fn(async () => {
    if (!ready) return false
    applied++
  })
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 10,
    refresh,
    onError,
  })
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
  expect(applied).toBe(0)
  ready = true
  await vi.waitFor(() => expect(applied).toBe(1))
  await settle()
  expect(applied).toBe(1)
  expect(onError).not.toHaveBeenCalled()
})

it('dispose cancels deferred retry promptly and never refreshes a closed runtime', async () => {
  const f = fixture(),
    onError = vi.fn(),
    refresh = vi.fn(async (_signal: AbortSignal) => false)
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 10,
    refresh,
    onError,
  })
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
  await f.item.watcher.dispose()
  expect(refresh.mock.calls[0]![0].aborted).toBe(true)
  const calls = refresh.mock.calls.length
  await settle()
  expect(refresh).toHaveBeenCalledTimes(calls)
  expect(onError).not.toHaveBeenCalled()
})

it('dispose waits for a running refresh and cancels queued and future generations', async () => {
  const f = fixture(),
    first = Promise.withResolvers<void>(),
    refresh = vi.fn(() => first.promise)
  f.item.watcher = startFrontendDevelopment({
    manifestPath: f.manifestPath,
    environment: { SUPERDSH_WATCH: '1' },
    debounceMs: 10,
    refresh,
    onError: (error) => {
      throw error
    },
  })
  f.commit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  f.commit()
  let finished = false
  const dispose = f.item.watcher.dispose().then(() => {
    finished = true
  })
  await settle()
  expect(finished).toBe(false)
  first.resolve()
  await dispose
  f.commit()
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
  await f.item.watcher.dispose()
})
