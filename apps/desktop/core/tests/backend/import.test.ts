import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  symlink,
  lstat,
  realpath,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { parse } from 'yaml'
import {
  IMPORT_PENDING,
  importDesktopData,
  inspectDesktopImport,
  rollbackDesktopImport,
  type DesktopImportOptions,
  type ImportDependencyRequest,
} from '../../src/backend/import/index.ts'

const roots: string[] = []
afterEach(async () => {
  const allowed = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root)
    if (
      !resolved.startsWith(`${allowed}${sep}`) ||
      !resolved.includes('superdsh-import-test-')
    )
      throw new Error('Unexpected test cleanup target')
    await rm(resolved, { recursive: true, force: true })
  }
})
const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
async function put(root: string, path: string, value: unknown): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}
async function fixture(source: 'desktop' | 'next' = 'desktop') {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'superdsh-import-test-')),
  )
  roots.push(root)
  const sourceHome = join(root, '来源'),
    targetHome = join(root, '目标')
  await mkdir(sourceHome)
  await mkdir(targetHome)
  const old = source === 'desktop' ? 'dsh-plugin-desktop' : 'dsh-desktop-next'
  await put(sourceHome, 'profiles/desktop/package.json', {
    dependencies: { [old]: '2.0.14', 'example-plugin': '1.2.3' },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-agent-preset',
          old,
          '@agents-anywhere/dsh-bridge-next',
          'example-plugin',
        ],
      },
      desktopNextOnboarding: { version: 1, outcome: 'completed' },
    },
  })
  await put(
    sourceHome,
    'profiles/desktop/cordis.patch.yml',
    `- id: old-shell\n  name: ${old}\n- id: user-plugin\n  name: example-plugin\n  config:\n    answer: 42\n`,
  )
  await put(
    sourceHome,
    'sessions/session-1/events.jsonl',
    '{"id":"s1","text":"中文会话"}\n',
  )
  await put(sourceHome, 'sessions/session-1/image.bin', 'attachment bytes')
  await put(sourceHome, 'settings.json', { theme: 'dark' })
  await put(sourceHome, 'credentials/provider.json', {
    encrypted: 'private-secret',
  })
  await put(sourceHome, '.env', 'TOKEN=private-secret')
  await put(sourceHome, 'agents-anywhere/desktop/account.json', {
    token: 'private-secret',
  })
  await put(
    sourceHome,
    'profiles/desktop/node_modules/example-plugin/index.js',
    'do not copy or execute',
  )
  await put(
    sourceHome,
    'profiles/desktop/pnpm-lock.yaml',
    'stale dependency lock',
  )
  await put(sourceHome, 'logs/old.log', 'stale logs')
  if (source === 'next')
    await put(sourceHome, 'desktop-next.json', {
      version: 1,
      active: 'desktop',
    })
  const options: DesktopImportOptions = {
    source,
    sourceHome,
    targetHome,
    listProcesses: async () => [],
    isProcessAlive: () => false,
  }
  return { root, sourceHome, targetHome, options }
}
const install = async (request: ImportDependencyRequest) => {
  expect(request.ignoreScripts).toBe(true)
  expect(await exists(join(request.home, IMPORT_PENDING))).toBe(true)
  for (const profile of request.profiles) {
    await put(profile.directory, 'node_modules/example-plugin/package.json', {
      name: 'example-plugin',
      version: '1.2.3',
    })
  }
}

describe('desktop data import', () => {
  it('copies data without writing the source, converts bundles, installs at the final path and can roll back', async () => {
    const { sourceHome, targetHome, options } = await fixture()
    const original = await readFile(
      join(sourceHome, 'profiles/desktop/package.json'),
      'utf8',
    )
    const result = await importDesktopData({
      ...options,
      installDependencies: async (request) => {
        expect(request.home).toBe(targetHome)
        await install(request)
      },
    })
    expect(
      await readFile(join(sourceHome, 'profiles/desktop/package.json'), 'utf8'),
    ).toBe(original)
    expect(
      await readFile(
        join(targetHome, 'sessions/session-1/events.jsonl'),
        'utf8',
      ),
    ).toBe(
      await readFile(
        join(sourceHome, 'sessions/session-1/events.jsonl'),
        'utf8',
      ),
    )
    const manifest = JSON.parse(
      await readFile(join(targetHome, 'profiles/desktop/package.json'), 'utf8'),
    )
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-agent-preset',
      'example-plugin',
      '@superdsh/harness',
      '@superdsh/desktop',
    ])
    expect(manifest.dependencies).toEqual({ 'example-plugin': '1.2.3' })
    const patch = parse(
      await readFile(
        join(targetHome, 'profiles/desktop/cordis.patch.yml'),
        'utf8',
      ),
    )
    expect(patch[0].disabled).toBe(true)
    expect(patch[1].config.answer).toBe(42)
    expect(
      await readFile(
        join(result.backupPath, 'profiles/desktop/package.json'),
        'utf8',
      ),
    ).toBe(original)
    for (const path of [
      'credentials',
      '.env',
      'agents-anywhere',
      'logs',
      'profiles/desktop/pnpm-lock.yaml',
      IMPORT_PENDING,
    ])
      expect(await exists(join(targetHome, path))).toBe(false)
    expect(result.reauthorization).toHaveLength(3)
    let stopped = 0
    const rollback = await rollbackDesktopImport({
      targetHome,
      assertTargetStopped: async () => {
        stopped++
      },
    })
    expect(stopped).toBe(2)
    expect(await readdir(targetHome)).toEqual([])
    expect(
      await exists(
        join(rollback.archivedHome, 'sessions/session-1/events.jsonl'),
      ),
    ).toBe(true)
    expect(await readFile(join(sourceHome, '.env'), 'utf8')).toContain(
      'private-secret',
    )
  })

  it('maps the known Next host/webserver patch while retaining the selected Profile', async () => {
    const { sourceHome, targetHome, options } = await fixture('next')
    await put(
      sourceHome,
      'cordis.patch.yml',
      '- name: dsh-desktop-next/webserver\n  config:\n    port: 1234\n',
    )
    await importDesktopData({ ...options, installDependencies: install })
    expect(
      parse(await readFile(join(targetHome, 'cordis.patch.yml'), 'utf8'))[0]
        .name,
    ).toBe('@superdsh/harness/webserver')
    expect(
      parse(
        await readFile(
          join(targetHome, 'profiles/desktop/cordis.patch.yml'),
          'utf8',
        ),
      )[0].name,
    ).toBe('@superdsh/harness')
    expect(
      JSON.parse(await readFile(join(targetHome, 'desktop-next.json'), 'utf8'))
        .active,
    ).toBe('desktop')
  })

  it('restores an empty target after install failure and preserves failed data for recovery', async () => {
    const { targetHome, options } = await fixture()
    let backupPath: string | undefined
    try {
      await importDesktopData({
        ...options,
        installDependencies: async () => {
          throw new Error('registry unavailable')
        },
      })
      throw new Error('expected failure')
    } catch (error) {
      backupPath = (error as { backupPath: string }).backupPath
      expect(String(error)).toContain('registry unavailable')
    }
    expect(await readdir(targetHome)).toEqual([])
    expect(
      await exists(
        join(backupPath!, '../failed-home/sessions/session-1/events.jsonl'),
      ),
    ).toBe(true)
    expect(
      await exists(join(backupPath!, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('detects a source modification during install and rolls back instead of committing a mixed snapshot', async () => {
    const { sourceHome, targetHome, options } = await fixture()
    await expect(
      importDesktopData({
        ...options,
        installDependencies: async () => {
          await put(sourceHome, 'sessions/new-event.json', { id: 2 })
        },
      }),
    ).rejects.toMatchObject({ code: 'source-changed' })
    expect(await readdir(targetHome)).toEqual([])
    expect(await exists(join(sourceHome, 'sessions/new-event.json'))).toBe(true)
  })

  it('leaves an originally absent target absent on failure', async () => {
    const { root, options } = await fixture()
    const targetHome = join(root, 'new-target')
    await expect(
      importDesktopData({
        ...options,
        targetHome,
        installDependencies: async () => {
          throw new Error('failure')
        },
      }),
    ).rejects.toThrow('failure')
    expect(await exists(targetHome)).toBe(false)
  })

  it('rejects same, nested and already populated destinations without installing', async () => {
    const { sourceHome, targetHome, options } = await fixture()
    for (const target of [
      sourceHome,
      join(sourceHome, 'child'),
      dirname(sourceHome),
    ]) {
      await expect(
        inspectDesktopImport({ ...options, targetHome: target }),
      ).rejects.toMatchObject({ code: 'path-conflict' })
    }
    await put(targetHome, 'keep.json', { keep: true })
    await expect(inspectDesktopImport(options)).rejects.toMatchObject({
      code: 'target-not-empty',
    })
    expect(await exists(join(targetHome, 'keep.json'))).toBe(true)
  })

  it('rejects directory junctions in source data', async () => {
    const { root, sourceHome, options } = await fixture()
    const external = join(root, 'external')
    await mkdir(external)
    await put(external, 'secret.txt', 'outside data')
    await symlink(external, join(sourceHome, 'linked-data'), 'junction')
    await expect(inspectDesktopImport(options)).rejects.toMatchObject({
      code: 'unsafe-file',
    })
    // The fixture cleanup removes the junction, not its target.
  })

  it('does not traverse node_modules junctions and excludes Profile credentials', async () => {
    const { root, sourceHome, targetHome, options } = await fixture()
    const external = join(root, 'external')
    await mkdir(external)
    await put(external, 'secret.txt', 'outside data')
    await symlink(
      external,
      join(sourceHome, 'profiles/node_modules'),
      'junction',
    )
    await put(
      sourceHome,
      'profiles/desktop/.env',
      'TOKEN=private-profile-token',
    )
    const result = await importDesktopData({
      ...options,
      installDependencies: install,
    })
    expect(result.skippedPaths).toContain('profiles/node_modules')
    expect(await exists(join(targetHome, 'profiles/desktop/.env'))).toBe(false)
    expect(await readFile(join(external, 'secret.txt'), 'utf8')).toBe(
      'outside data',
    )
  })

  it('does not import Electron browser cookies, cached data or login storage from an old Next home', async () => {
    const { sourceHome, targetHome, options } = await fixture('next')
    await put(
      sourceHome,
      'electron-user-data/Default/Network/Cookies',
      'old browser login cookies',
    )
    await put(
      sourceHome,
      'electron-user-data/Cache/cached.bin',
      'rebuildable browser cache',
    )
    const result = await importDesktopData({
      ...options,
      installDependencies: install,
    })
    expect(result.skippedPaths).toContain('electron-user-data')
    expect(await exists(join(targetHome, 'electron-user-data'))).toBe(false)
    expect(
      await readFile(
        join(sourceHome, 'electron-user-data/Default/Network/Cookies'),
        'utf8',
      ),
    ).toBe('old browser login cookies')
    expect(
      await exists(join(targetHome, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('rejects an aliased target ancestor', async () => {
    const { root, sourceHome, options } = await fixture()
    const alias = join(root, 'alias')
    await symlink(sourceHome, alias, 'junction')
    await expect(
      inspectDesktopImport({ ...options, targetHome: join(alias, 'new') }),
    ).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('blocks live source processes, active or unknown locks, and failed process inspection', async () => {
    const { sourceHome, options } = await fixture()
    await expect(
      inspectDesktopImport({
        ...options,
        listProcesses: async () => [{ pid: 987654, name: 'DSH NEXT.exe' }],
      }),
    ).rejects.toMatchObject({ code: 'source-running' })
    await expect(
      inspectDesktopImport({
        ...options,
        listProcesses: async () => [
          {
            pid: 987654,
            name: '',
            commandLine:
              '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'source-running' })
    await put(sourceHome, 'profiles/desktop/lock.lock', '876543')
    await expect(
      inspectDesktopImport({ ...options, isProcessAlive: () => true }),
    ).rejects.toMatchObject({ code: 'source-locked' })
    const plan = await inspectDesktopImport(options)
    expect(plan.warnings.some((warning) => warning.code === 'stale-lock')).toBe(
      true,
    )
    expect(
      await readFile(join(sourceHome, 'profiles/desktop/lock.lock'), 'utf8'),
    ).toBe('876543')
    await put(sourceHome, 'profiles/desktop/lock.lock', 'unknown owner')
    await expect(inspectDesktopImport(options)).rejects.toMatchObject({
      code: 'source-locked',
    })
    await expect(
      inspectDesktopImport({
        ...options,
        listProcesses: async () => {
          throw new Error('access denied')
        },
      }),
    ).rejects.toMatchObject({ code: 'process-check-failed' })
  })

  it('cancels copying without changing source or publishing the target', async () => {
    const { sourceHome, targetHome, options } = await fixture()
    const controller = new AbortController()
    await expect(
      importDesktopData({
        ...options,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'backup') controller.abort()
        },
        installDependencies: install,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readdir(targetHome)).toEqual([])
    expect(
      await exists(join(sourceHome, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('refuses rollback once imported business data changes', async () => {
    const { targetHome, options } = await fixture()
    await importDesktopData({ ...options, installDependencies: install })
    await put(targetHome, 'sessions/session-1/events.jsonl', 'new user message')
    await expect(
      rollbackDesktopImport({
        targetHome,
        assertTargetStopped: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'target-changed' })
    expect(
      await readFile(
        join(targetHome, 'sessions/session-1/events.jsonl'),
        'utf8',
      ),
    ).toBe('new user message')
  })

  it('rejects local plugin dependencies instead of installing through the original source', async () => {
    const { sourceHome, options } = await fixture()
    const path = join(sourceHome, 'profiles/desktop/package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.dependencies['example-plugin'] = 'file:../../secret-plugin'
    await writeFile(path, JSON.stringify(manifest))
    await expect(inspectDesktopImport(options)).rejects.toMatchObject({
      code: 'local-dependency',
    })
  })

  it('removes source package-manager hooks, workspace config and dependency redirects before installation', async () => {
    const { sourceHome, targetHome, options } = await fixture()
    await put(sourceHome, '.npmrc', `store-dir=${sourceHome}\n`)
    await put(
      sourceHome,
      'pnpm-workspace.yaml',
      'packages:\n  - "../source/**"\n',
    )
    await put(
      sourceHome,
      'profiles/desktop/.pnpmfile.cjs',
      'throw new Error("must not execute")',
    )
    const path = join(sourceHome, 'profiles/desktop/package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.pnpm = {
      overrides: { 'example-plugin': 'file:../../secret-plugin' },
    }
    manifest.workspaces = ['../../secret-plugin']
    manifest.scripts = { preinstall: 'node unsafe.js' }
    await writeFile(path, JSON.stringify(manifest))
    const result = await importDesktopData({
      ...options,
      installDependencies: async (request) => {
        const imported = JSON.parse(
          await readFile(
            join(request.profiles[0]!.directory, 'package.json'),
            'utf8',
          ),
        )
        expect(imported.pnpm).toBeUndefined()
        expect(imported.workspaces).toBeUndefined()
        expect(imported.scripts).toBeUndefined()
        expect(await exists(join(request.home, '.npmrc'))).toBe(false)
        expect(await exists(join(request.home, 'pnpm-workspace.yaml'))).toBe(
          false,
        )
        expect(
          await exists(join(request.profiles[0]!.directory, '.pnpmfile.cjs')),
        ).toBe(false)
      },
    })
    expect(
      result.warnings.some(
        (warning) => warning.code === 'install-policy-reset',
      ),
    ).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).pnpm).toEqual(manifest.pnpm)
    expect(
      JSON.parse(
        await readFile(
          join(result.backupPath, 'profiles/desktop/package.json'),
          'utf8',
        ),
      ).pnpm,
    ).toEqual(manifest.pnpm)
    expect(
      await exists(join(targetHome, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('blocks a competing import and never overwrites its destination', async () => {
    const { targetHome, options } = await fixture()
    let enter!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      enter = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = importDesktopData({
      ...options,
      installDependencies: async () => {
        enter()
        await waiting
      },
    })
    await started
    try {
      await expect(
        importDesktopData({ ...options, installDependencies: install }),
      ).rejects.toMatchObject({ code: 'target-not-empty' })
    } finally {
      release()
    }
    await first
    expect(
      await exists(join(targetHome, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('rejects a forged rollback receipt without moving the imported Home', async () => {
    const { targetHome, options } = await fixture()
    const result = await importDesktopData({
      ...options,
      installDependencies: install,
    })
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'))
    receipt.sourceHome = 'forged-source'
    await writeFile(result.receiptPath, JSON.stringify(receipt))
    await expect(
      rollbackDesktopImport({
        targetHome,
        assertTargetStopped: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'invalid-receipt' })
    expect(
      await exists(join(targetHome, 'sessions/session-1/events.jsonl')),
    ).toBe(true)
  })

  it('refuses source-kind mismatch before creating an import transaction', async () => {
    const { root, options } = await fixture()
    await expect(
      inspectDesktopImport({ ...options, source: 'next' }),
    ).rejects.toMatchObject({ code: 'source-mismatch' })
    expect(
      (await readdir(root)).filter((name) => name.includes('.import-')),
    ).toEqual([])
  })
})
