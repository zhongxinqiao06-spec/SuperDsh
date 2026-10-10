/** Recovery owns destructive repair sequencing and its temporary CLI process. */
import { isAbsolute, join } from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'
import type { NextDesktopRuntime } from '../backend/desktop-runtime.ts'
import type { DesktopState } from '../contracts/desktop-contract.ts'
import { createPackageRunner } from './extensions.ts'
import { validateDataDirectory } from './data-directory.ts'
import { atomicJson } from '../backend/private-files.ts'
import { maskSecrets } from '../backend/mask-secrets.ts'
interface RecoveryActionsOptions {
  runtime: NextDesktopRuntime
  home: string
  defaultHome: string
  locationFile: string
  accountSpace?: boolean
  t(zh: string, en: string): string
  confirmed(title: string, detail: string): Promise<boolean>
  openPath(path: string): Promise<void>
  raiseDialogOwner(): BrowserWindow | undefined
  diagnosticsFile(): string | undefined
  waitForStop(): Promise<void>
  notice(value: NonNullable<DesktopState['recovery']>['notice']): void
  relaunch(): void
}
export function createRecoveryActions(options: RecoveryActionsOptions) {
  const {
    runtime,
    home,
    defaultHome,
    locationFile,
    t,
    confirmed,
    openPath,
    raiseDialogOwner,
  } = options
  let recoveryRunner: ReturnType<typeof createPackageRunner> | undefined
  async function restoreCheckpoint(id?: string): Promise<void> {
    await runtime.recovery.restore(runtime.selected, id)
    // A checkpoint holds configuration only, so the restored manifest deliberately disagrees with the
    // lockfile until this install reconciles them. pnpm refuses that reconciliation whenever it treats
    // the environment as CI, which would make recovery fail exactly where it is needed.
    try {
      await runRecoveryPlugin(['install', '--no-frozen-lockfile'])
    } catch (error) {
      throw new Error(
        t(
          '配置已恢复，但插件依赖安装失败。请检查以下错误并重试恢复：',
          'Configuration was restored, but plugin dependencies could not be installed. Check the error and retry recovery:',
        ) +
          '\n' +
          String(error),
        { cause: error },
      )
    }
    options.notice({
      tone: 'success',
      title: t('检查点已恢复', 'Checkpoint restored'),
      body: runtime.safeMode
        ? t(
            '配置和所需插件依赖已恢复。请点击“退出安全模式并重启”使恢复生效。',
            'Configuration and required plugin dependencies have been restored. Choose “Exit Safe Mode and Restart” to apply them.',
          )
        : t(
            '配置和所需插件依赖已恢复。请点击“退出并重启”使恢复生效。',
            'Configuration and required plugin dependencies have been restored. Choose “Quit and restart” to apply them.',
          ),
    })
    runtime.diagnostics.append(
      `Recovered checkpoint ${id} for ${runtime.selected}`,
    )
  }

  /** Reconcile dependencies through the same official CLI for recovery install and removal. */
  async function runRecoveryPlugin(args: readonly string[]): Promise<void> {
    const directory = runtime.profiles.directory(runtime.selected)
    const runner = (recoveryRunner = createPackageRunner(
      {
        command: process.execPath,
        args: [],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      directory,
    ))
    let output = ''
    try {
      const operation = runner.runPlugin(
        args,
        directory,
        AbortSignal.timeout(120_000),
      )
      const append = (chunk: unknown): void => {
        output = (output + String(chunk)).slice(-16_384)
        runtime.diagnostics.hostChunk(String(chunk))
      }
      operation.stdout.on('data', append)
      operation.stderr.on('data', append)
      const result = await operation.done
      if (result.exitCode !== 0)
        throw new Error(
          maskSecrets(
            `Plugin ${args[0]} failed (exit ${result.exitCode}): ${output}`,
          ),
        )
    } finally {
      await runner.dispose()
      if (recoveryRunner === runner) recoveryRunner = undefined
    }
  }

  async function recoveryAction(input: Record<string, unknown>): Promise<void> {
    if (!runtime.recoveryMode && !runtime.safeMode)
      throw new Error('Open recovery before changing its configuration')
    const action = input.action
    options.notice(undefined)
    if (action === 'restart') {
      if (
        !(await confirmed(
          runtime.safeMode
            ? t('退出安全模式并重启？', 'Exit Safe Mode and restart?')
            : t('现在重启 SuperDsh？', 'Restart SuperDsh now?'),
          runtime.safeMode
            ? t(
                '应用将返回原 Profile，并移除临时环境。临时数据不会保留，正在运行的任务会中断。',
                'The app will return to the original Profile and remove the temporary environment. Temporary data will not be kept, and running tasks will be interrupted.',
              )
            : t(
                '应用将退出恢复助手，重新启动原 Profile。',
                'The app will leave the recovery assistant and restart the original Profile.',
              ),
        ))
      )
        return
      options.relaunch()
      return
    }
    const directory = runtime.profiles.directory(runtime.selected)
    const files: Record<string, string> = {
      'open-settings-document': join(home, 'settings.yaml'),
      'open-profile-patch': join(directory, 'cordis.patch.yml'),
      'open-profile-manifest': join(directory, 'package.json'),
    }
    if (typeof action !== 'string') throw new Error('Invalid recovery action')
    if (Object.hasOwn(files, action)) {
      await openPath(files[action]!)
      return
    }
    if (action === 'show-diagnostics') {
      const diagnosticsFile = options.diagnosticsFile()
      if (!diagnosticsFile) throw new Error('No exported diagnostics')
      shell.showItemInFolder(diagnosticsFile)
      return
    }
    if (action === 'open-checkpoint' || action === 'preview-checkpoint') {
      const checkpoint = runtime.recovery
        .checkpoints(runtime.selected)
        .find((item) => item.id === input.id)
      if (!checkpoint)
        throw new Error('Recovery checkpoint is no longer available')
      if (action === 'open-checkpoint') {
        await openPath(checkpoint.directory)
        return
      }
      if (
        !(await confirmed(
          t('还原所选配置备份？', 'Restore the selected configuration backup?'),
          t(
            `备份时间：${checkpoint.created}。当前配置会先备份，然后恢复配置并安装所需插件依赖。共享数据不会回滚。`,
            `Saved: ${checkpoint.created}. Current configuration will be backed up, then the saved configuration and required plugin dependencies will be restored. Shared data is not rolled back.`,
          ),
        ))
      )
        return
      await options.waitForStop()
      if (!runtime.safeMode) await runtime.backend.stop()
      await restoreCheckpoint(checkpoint.id)
      return
    }
    if (action === 'preview-disable' || action === 'preview-enable') {
      const enable = action === 'preview-enable'
      const bundle = runtime.recovery
        .bundles(runtime.selected)
        .find((item) => item.bundleId === input.id)
      if (
        !bundle ||
        bundle.toggle !== (enable ? 'enable' : 'disable') ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(
          bundle.packageName,
        )
      )
        throw new Error('This plugin cannot be changed')
      if (
        !(await confirmed(
          enable
            ? t(
                `启用插件「${bundle.packageName}」？`,
                `Enable “${bundle.packageName}”?`,
              )
            : t(
                `禁用插件「${bundle.packageName}」？`,
                `Disable “${bundle.packageName}”?`,
              ),
          enable
            ? t(
                '下次启动时会重新加载此插件。',
                'The plugin will load again on the next start.',
              )
            : t(
                '不会删除任何内容：插件、版本声明和配置都会保留，只是下次启动时不再加载。随时可以重新启用。',
                'Nothing is deleted: the plugin, its version declaration and its configuration all stay. It simply will not load on the next start, and you can enable it again at any time.',
              ),
        ))
      )
        return
      await options.waitForStop()
      if (!runtime.safeMode) await runtime.backend.stop()
      await runtime.recovery.setBundleSelected(
        runtime.selected,
        bundle.packageName,
        enable,
      )
      options.notice({
        tone: 'success',
        title: bundle.packageName,
        body: enable
          ? t(
              '插件已重新启用。请点击“退出并重启”使其生效。',
              'The plugin is enabled again. Choose “Quit and restart” to apply it.',
            )
          : t(
              '插件已禁用，安装内容仍然保留。请点击“退出并重启”使其生效。',
              'The plugin is disabled and still installed. Choose “Quit and restart” to apply it.',
            ),
      })
      runtime.diagnostics.append(
        `${enable ? 'Enabled' : 'Disabled'} bundle for ${runtime.selected}`,
      )
      return
    }
    if (action === 'preview-uninstall') {
      const bundle = runtime.recovery
        .bundles(runtime.selected)
        .find((item) => item.bundleId === input.id)
      if (
        !bundle ||
        bundle.action !== 'uninstall' ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(
          bundle.packageName,
        )
      )
        throw new Error('This bundle cannot be uninstalled')
      if (
        !(await confirmed(
          t(
            `卸载插件「${bundle.packageName}」？`,
            `Uninstall “${bundle.packageName}”?`,
          ),
          t(
            '先备份当前 Profile 配置，然后卸载所选插件。',
            'Back up the Profile configuration, then uninstall the selected plugin.',
          ),
        ))
      )
        return
      await options.waitForStop()
      if (!runtime.safeMode) await runtime.backend.stop()
      runtime.recovery.backup(runtime.selected, 'before-plugin-uninstall')
      await runRecoveryPlugin(['remove', bundle.packageName])
      return
    }
    if (
      action === 'begin-change-data-directory' ||
      action === 'restore-default-data-directory'
    ) {
      if (options.accountSpace)
        throw new Error(
          '平台账号的数据目录由账号隔离管理。请先切换到本地空间，再修改本地数据目录。',
        )
      const owner =
        action === 'begin-change-data-directory'
          ? raiseDialogOwner()
          : undefined
      const choice =
        action !== 'begin-change-data-directory'
          ? undefined
          : await (owner === undefined
              ? dialog.showOpenDialog({
                  properties: ['openDirectory', 'createDirectory'],
                })
              : dialog.showOpenDialog(owner, {
                  properties: ['openDirectory', 'createDirectory'],
                }))
      if (choice?.canceled) return
      const target =
        action === 'restore-default-data-directory'
          ? defaultHome
          : choice?.filePaths[0]
      if (!target || !isAbsolute(target)) return
      const destination = validateDataDirectory(target, home, defaultHome)
      if (destination === home) return
      if (
        !(await confirmed(
          t('切换数据目录并重启？', 'Change data directory and restart?'),
          t(
            `新目录：${destination}。原目录的数据会保留，不会自动迁移。`,
            `New directory: ${destination}. Existing data remains in its original directory and is not moved.`,
          ),
        ))
      )
        return
      atomicJson(locationFile, { home: destination })
      options.relaunch()
      return
    }
    if (action === 'factory-reset') {
      if (
        !(await confirmed(
          t(
            '重置当前数据目录并重启？',
            'Reset the current data directory and restart?',
          ),
          t(
            'Profile、会话、设置和凭据将移入 recovery 备份目录，应用将重新初始化。',
            'Profiles, sessions, settings and credentials will move to a recovery backup. The app will initialize again.',
          ),
        ))
      )
        return
      await options.waitForStop()
      await runtime.backend.stop()
      runtime.diagnostics.flush()
      runtime.recovery.factoryReset()
      options.relaunch()
      return
    }
    throw new Error('Unknown recovery action')
  }

  return {
    execute: recoveryAction,
    restoreCheckpoint,
    dispose: async () => {
      await recoveryRunner?.dispose()
    },
  }
}
