import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NextDesktopRuntime } from '../../src/backend/desktop-runtime.ts'
import { DesktopHostProcess } from '../../src/backend/host-process.ts'

it('never starts a Host for a Home whose import transaction has not committed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superdsh-pending-import-'))
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start')
  const runtime = new NextDesktopRuntime({
    home,
    root: home,
    executable: process.execPath,
    addresses: () => [],
    certificate: async () => {
      throw new Error('Certificate must not be requested')
    },
    onFailure() {},
    onChange() {},
    onRestart() {},
    onTerminal() {},
    onNotification() {},
  })
  try {
    writeFileSync(join(home, '.superdsh-import-pending.json'), '{}')
    await expect(runtime.start()).rejects.toThrow('import has not completed')
    expect(start).not.toHaveBeenCalled()
  } finally {
    await runtime.close()
    start.mockRestore()
    rmSync(home, { recursive: true, force: true })
  }
})
