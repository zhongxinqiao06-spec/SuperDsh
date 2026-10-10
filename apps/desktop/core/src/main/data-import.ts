import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  importDesktopData,
  inspectDesktopImport,
  rollbackDesktopImport,
  type DesktopImportPlan,
  type DesktopImportResult,
  type ImportDependencyRequest,
} from '@superdsh/core/backend/import'
import type {
  ImportDefaults,
  ImportProgress,
  ImportSelection,
} from '../contracts/import-contract.ts'

export interface DesktopDataImportOptions {
  defaultHome: string
  currentHome: string
  desktopHome: string
  nextHome: string
  browse(): Promise<string | null>
  stopBackend(): Promise<() => Promise<void>>
  installDependencies(request: ImportDependencyRequest): Promise<void>
  assertTargetStopped(home: string): Promise<void>
  activate(home: string): Promise<void>
  progress(value: ImportProgress): void
}

/** Create only real directories; a user-data junction must never redirect an import. */
async function ensureImportParent(directory: string): Promise<void> {
  const parent = dirname(directory)
  if (parent !== directory) await ensureImportParent(parent)
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('导入目录不能包含符号链接或特殊文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
    }
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('导入目录不能包含符号链接或特殊文件', { cause: error })
  }
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}

/** Import state is private to the native shell; the renderer never supplies executable operations. */
export class DesktopDataImport {
  private plan?: DesktopImportPlan
  private result?: DesktopImportResult
  private inspectedSelection?: ImportSelection
  private error?: string
  private pending?: Promise<unknown>
  private controller?: AbortController
  private readonly target: string
  constructor(private readonly options: DesktopDataImportOptions) {
    this.target = join(
      dirname(options.defaultHome),
      'imports',
      `import-${randomUUID()}`,
    )
  }
  get busy(): boolean {
    return this.pending !== undefined
  }
  defaults(): ImportDefaults {
    return {
      desktopHome: this.options.desktopHome,
      nextHome: this.options.nextHome,
      targetHome: this.target,
      selection: this.inspectedSelection,
      plan: this.plan,
      result: this.result,
      error: this.error,
    }
  }
  private selection(value: unknown): ImportSelection {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid import selection')
    const candidate = value as Partial<ImportSelection>
    if (
      !['desktop', 'next'].includes(String(candidate.source)) ||
      typeof candidate.sourceHome !== 'string' ||
      candidate.sourceHome.length > 32768 ||
      candidate.targetHome !== this.target
    )
      throw new Error('Invalid import selection')
    return candidate as ImportSelection
  }
  async dispatch(action: unknown, value?: unknown): Promise<unknown> {
    if (action === 'cancel') {
      this.controller?.abort(new Error('导入已取消'))
      return
    }
    // Reopening the view waits for a cancelled/in-flight transaction and restores its outcome.
    if (action === 'defaults') {
      await this.pending?.catch(() => {})
      return this.defaults()
    }
    if (this.busy) throw new Error('导入操作尚未结束')
    if (action === 'browse') return this.options.browse()
    if (
      action !== 'inspect' &&
      action !== 'execute' &&
      action !== 'rollback' &&
      action !== 'use'
    )
      throw new Error('Unknown import action')
    this.controller = new AbortController()
    this.error = undefined
    const signal = this.controller.signal
    const operation = async (): Promise<unknown> => {
      if (action === 'use') {
        if (!this.result) throw new Error('没有已完成的导入')
        await this.options.assertTargetStopped(this.result.targetHome)
        signal.throwIfAborted()
        return this.options.activate(this.result.targetHome)
      }
      if (action === 'rollback') {
        if (!this.result) throw new Error('没有可以回退的导入')
        const targetHome = this.result.targetHome
        await rollbackDesktopImport({
          targetHome,
          signal,
          assertTargetStopped: () =>
            this.options.assertTargetStopped(targetHome),
        })
        this.result = undefined
        this.plan = undefined
        this.inspectedSelection = undefined
        return
      }
      if (this.result) throw new Error('请先使用或回退已经完成的导入')
      const selection = this.selection(value)
      const options = {
        ...selection,
        signal,
        onProgress: this.options.progress,
      }
      if (action === 'inspect') {
        this.plan = undefined
        this.inspectedSelection = undefined
        await ensureImportParent(dirname(this.target))
        signal.throwIfAborted()
        this.plan = await inspectDesktopImport(options)
        this.inspectedSelection = { ...selection }
        return this.plan
      }
      if (
        !this.plan ||
        !this.inspectedSelection ||
        this.plan.source !== selection.source ||
        !(
          this.inspectedSelection.sourceHome === selection.sourceHome ||
          samePath(this.plan.sourceHome, selection.sourceHome)
        )
      )
        throw new Error('请先检查当前选择的数据目录')
      const resume = await this.options.stopBackend()
      try {
        this.result = await importDesktopData({
          ...options,
          installDependencies: this.options.installDependencies,
        })
        return this.result
      } finally {
        await resume()
      }
    }
    this.pending = operation()
    try {
      return await this.pending
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.pending = undefined
      this.controller = undefined
    }
  }
  async close(): Promise<void> {
    this.controller?.abort(new Error('应用正在退出，取消导入'))
    await this.pending?.catch(() => {})
  }
}
