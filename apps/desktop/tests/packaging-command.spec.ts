import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runNextPackagingCommand } from '../scripts/packaging-command.ts'
import { prepareNodeShim } from '../scripts/node-shim.ts'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const spawn = vi.mocked(spawnSync)
afterEach(() => spawn.mockReset())
const succeeded: ReturnType<typeof spawnSync> = {
  status: 0,
  output: [],
  pid: 1,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
}

it('runs the current workspace gate once and aborts packaging on failure', () => {
  const env = { PATH: '/test/bin' }
  spawn.mockReturnValue(succeeded)
  runNextPackagingCommand(
    'yarn',
    ['run', 'check'],
    '/workspace',
    env,
    '/workspace',
  )
  expect(spawn.mock.calls.map((call) => call[1])).toEqual([['run', 'check']])
  expect(spawn.mock.calls.every((call) => call[2]?.env === env)).toBe(true)
  spawn.mockReset().mockReturnValue({ ...succeeded, status: 1 })
  expect(() =>
    runNextPackagingCommand(
      'yarn',
      ['run', 'check'],
      '/workspace',
      env,
      '/workspace',
    ),
  ).toThrow('Packaging command failed')
  expect(spawn).toHaveBeenCalledOnce()
})

it('preserves the explicitly selected application gate and its environment', () => {
  spawn.mockReturnValue(succeeded)
  const env = { PATH: '/build/bin', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  runNextPackagingCommand(
    'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      'corepack yarn workspace @superdsh/desktop check:win-package',
    ],
    '/workspace',
    env,
    '/workspace',
  )
  expect(spawn).toHaveBeenCalledOnce()
  expect(spawn.mock.calls[0]?.[1]).toContain(
    'corepack yarn workspace @superdsh/desktop check:win-package',
  )
  expect(spawn.mock.calls[0]?.[2]?.env).toBe(env)
})

it('restores the owned Node shim executable mode for native POSIX builds only', () => {
  const root = mkdtempSync(join(tmpdir(), 'superdsh-node-shim-'))
  try {
    const shim = join(root, 'scripts', 'node-bin', 'node')
    mkdirSync(join(root, 'scripts', 'node-bin'), { recursive: true })
    writeFileSync(shim, '#!/bin/sh\nexec node "$@"\n', { mode: 0o644 })
    const chmod = vi.fn()
    prepareNodeShim(root, 'linux', chmod)
    prepareNodeShim(root, 'darwin', chmod)
    expect(chmod.mock.calls).toEqual([
      [shim, 0o755],
      [shim, 0o755],
    ])
    prepareNodeShim(join(root, 'absent'), 'win32', chmod)
    expect(chmod).toHaveBeenCalledTimes(2)
    rmSync(shim)
    mkdirSync(shim)
    expect(() => prepareNodeShim(root, 'linux', chmod)).toThrow(
      'regular file inside the desktop package',
    )
    expect(chmod).toHaveBeenCalledTimes(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
