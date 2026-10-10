import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DesktopDataImport,
  type DesktopDataImportOptions,
} from '../../src/main/data-import.ts'
import type {
  ImportDefaults,
  ImportSelection,
} from '../../src/contracts/import-contract.ts'

// Exercise the real copy/rollback implementation against temporary data. Only the
// operating-system process probe is replaced so the test never inspects user apps.
vi.mock('@superdsh/core/backend/import', async () => {
  const core = await import('../../src/backend/import/index.ts')
  return {
    ...core,
    inspectDesktopImport: (
      options: Parameters<typeof core.inspectDesktopImport>[0],
    ) =>
      core.inspectDesktopImport({ ...options, listProcesses: async () => [] }),
    importDesktopData: (
      options: Parameters<typeof core.importDesktopData>[0],
    ) => core.importDesktopData({ ...options, listProcesses: async () => [] }),
  }
})

const roots: string[] = []
afterEach(async () => {
  const allowed = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    const canonical = await realpath(root)
    if (
      !canonical.startsWith(`${allowed}${sep}`) ||
      !canonical.includes('superdsh-controller-test-')
    )
      throw new Error('Unsafe fixture cleanup')
    await rm(canonical, { recursive: true, force: true })
  }
})
async function fixture(overrides: Partial<DesktopDataImportOptions> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'superdsh-controller-test-')),
  )
  roots.push(root)
  const sourceHome = join(root, '旧桌面'),
    defaultHome = join(root, 'SuperDsh', 'home')
  await mkdir(join(sourceHome, 'profiles', 'desktop'), { recursive: true })
  await writeFile(
    join(sourceHome, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['dsh-plugin-desktop'] } } }),
  )
  await writeFile(
    join(sourceHome, 'conversation.json'),
    '{"message":"preserve me"}',
  )
  const resume = vi.fn(async () => {})
  const options: DesktopDataImportOptions = {
    defaultHome,
    currentHome: defaultHome,
    desktopHome: sourceHome,
    nextHome: join(root, 'Next', 'home'),
    browse: async () => sourceHome,
    stopBackend: vi.fn(async () => resume),
    installDependencies: vi.fn(async () => {}),
    assertTargetStopped: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    progress: () => {},
    ...overrides,
  }
  const controller = new DesktopDataImport(options)
  const defaults = (await controller.dispatch('defaults')) as ImportDefaults
  const selection: ImportSelection = {
    source: 'desktop',
    sourceHome,
    targetHome: defaults.targetHome,
  }
  return { root, sourceHome, controller, options, resume, selection }
}
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('creates the import parent, accepts the checked canonical source, and restores a completed result when reopened', async () => {
  const { controller, options, resume, selection, sourceHome } = await fixture()
  const raw = { ...selection, sourceHome: `${sourceHome}${sep}.${sep}` }
  const plan = (await controller.dispatch('inspect', raw)) as {
    sourceHome: string
  }
  expect(await readdir(dirname(selection.targetHome))).toEqual([])
  const result = await controller.dispatch('execute', {
    ...selection,
    sourceHome: plan.sourceHome,
  })
  expect(options.stopBackend).toHaveBeenCalledOnce()
  expect(resume).toHaveBeenCalledOnce()
  expect(
    await readFile(join(sourceHome, 'conversation.json'), 'utf8'),
  ).toContain('preserve me')
  await controller.close()
  const reopened = (await controller.dispatch('defaults')) as ImportDefaults
  expect(reopened.result).toEqual(result)
  expect(reopened.plan?.sourceHome).toBe(sourceHome)
  expect(reopened.selection?.sourceHome).toBe(raw.sourceHome)
  await controller.dispatch('rollback')
  expect(
    ((await controller.dispatch('defaults')) as ImportDefaults).result,
  ).toBeUndefined()
})

it('rejects a junction in the import parent before touching its destination', async () => {
  const { root, controller, selection } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  const imports = dirname(selection.targetHome)
  await mkdir(dirname(imports))
  await symlink(outside, imports, 'junction')
  await expect(controller.dispatch('inspect', selection)).rejects.toThrow(
    '符号链接',
  )
  expect(await readdir(outside)).toEqual([])
})

it('rejects renderer target changes and requires the inspected source before stopping the backend', async () => {
  const { root, controller, options, selection } = await fixture()
  await expect(
    controller.dispatch('inspect', {
      ...selection,
      targetHome: join(root, 'renderer-choice'),
    }),
  ).rejects.toThrow('Invalid import selection')
  await expect(controller.dispatch('execute', selection)).rejects.toThrow(
    '请先检查',
  )
  await controller.dispatch('inspect', selection)
  await expect(
    controller.dispatch('execute', {
      ...selection,
      sourceHome: join(root, 'changed-source'),
    }),
  ).rejects.toThrow('请先检查')
  expect(options.stopBackend).not.toHaveBeenCalled()
})

it('serializes activation and prevents activation after close while the stopped check is pending', async () => {
  const entered = gate(),
    continueCheck = gate()
  const { controller, options, selection } = await fixture({
    assertTargetStopped: async () => {
      entered.resolve()
      await continueCheck.promise
    },
  })
  await controller.dispatch('inspect', selection)
  await controller.dispatch('execute', selection)
  const use = controller.dispatch('use')
  const failure = expect(use).rejects.toThrow('取消导入')
  await entered.promise
  await expect(controller.dispatch('rollback')).rejects.toThrow('尚未结束')
  const closed = controller.close()
  expect(controller.busy).toBe(true)
  continueCheck.resolve()
  await closed
  await failure
  expect(options.activate).not.toHaveBeenCalled()
  expect(controller.busy).toBe(false)
  expect(
    ((await controller.dispatch('defaults')) as ImportDefaults).result,
  ).toBeDefined()
})

it('cancels an installation, waits for rollback and resumes the previous backend before exposing state', async () => {
  const entered = gate()
  const { controller, resume, selection } = await fixture({
    installDependencies: async (request) => {
      entered.resolve()
      await new Promise<void>((_resolve, reject) =>
        request.signal!.addEventListener(
          'abort',
          () => reject(request.signal!.reason),
          { once: true },
        ),
      )
    },
  })
  await controller.dispatch('inspect', selection)
  const execution = controller.dispatch('execute', selection)
  const failure = expect(execution).rejects.toThrow('导入已取消')
  await entered.promise
  const snapshot = controller.dispatch('defaults')
  await controller.dispatch('cancel')
  await failure
  const reopened = (await snapshot) as ImportDefaults
  expect(reopened.result).toBeUndefined()
  expect(reopened.error).toContain('导入已取消')
  expect(resume).toHaveBeenCalledOnce()
  expect(await readdir(dirname(selection.targetHome))).not.toContain(
    selection.targetHome.split(sep).at(-1),
  )
})
