import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ autoUpdater: { on: vi.fn() } }))
import {
  assertNextMacBundle,
  assertNextWindowsInstaller,
} from '../../src/main/update-installer.ts'

it('rejects legacy Desktop installers and an unexpected release even when the archive is valid', () => {
  expect(() =>
    assertNextMacBundle(
      'com.superdsh.desktop',
      { name: '@superdsh/desktop', version: '2.0.14' },
      '2.0.14',
    ),
  ).not.toThrow()
  expect(() =>
    assertNextMacBundle(
      'ai.deepseek.dsh.desktop.next',
      { name: '@superdsh/desktop', version: '2.0.14' },
      '2.0.14',
    ),
  ).toThrow()
  expect(() =>
    assertNextMacBundle(
      'ai.deepseek.dsh.desktop.beta',
      { name: '@superdsh/desktop', version: '2.0.14' },
      '2.0.14',
    ),
  ).toThrow()
  expect(() =>
    assertNextMacBundle(
      'com.superdsh.desktop',
      { name: '@superdsh/desktop', version: '2.0.13' },
      '2.0.14',
    ),
  ).toThrow()
  expect(() =>
    assertNextWindowsInstaller(
      { ProductName: 'SuperDsh', ProductVersion: '2.0.14' },
      '2.0.14',
    ),
  ).not.toThrow()
  expect(() =>
    assertNextWindowsInstaller(
      { ProductName: 'DSH Desktop Beta', ProductVersion: '2.0.14' },
      '2.0.14',
    ),
  ).toThrow()
})
