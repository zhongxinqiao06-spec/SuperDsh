/** Copy-only desktop migration. No source plugin is loaded and no source file is written. */
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  writeFile,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { assertImportSourceStopped } from './activity.ts'
import {
  assertEmptyTarget,
  assertRealPath,
  canonicalPath,
  checkAbort,
  digestFile,
  fingerprint,
  IMPORT_PENDING,
  RECEIPT,
  sameFiles,
  snapshotDigest,
  treeFiles,
  validateLocations,
  type ImportFile,
} from './files.ts'
import {
  convertImportedProfiles,
  inspectProfiles,
  readImportJson,
  validProfileName,
} from './profiles.ts'
import {
  DesktopImportError,
  type DesktopImportOptions,
  type DesktopImportPlan,
  type DesktopImportResult,
  type ExecuteDesktopImportOptions,
  type RollbackDesktopImportOptions,
} from '../../contracts/import-types.ts'
export * from '../../contracts/import-types.ts'
export { IMPORT_PENDING } from './files.ts'
export { assertImportSourceStopped } from './activity.ts'

const reauthorization = [
  '重新确认模型服务凭据；系统密钥链和独立 credentials 文件不会复制。',
  '重新登录 DeepSeek 平台及需要授权的外部服务。',
  'Agents Anywhere 账号、设备绑定与 Connector 运行状态不复制；请重新登录绑定。',
] as const
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export async function inspectDesktopImport(
  options: DesktopImportOptions,
): Promise<DesktopImportPlan> {
  checkAbort(options.signal)
  if (!['desktop', 'next'].includes(options.source))
    throw new DesktopImportError('invalid-source', '请选择主桌面或 Next 来源。')
  const locations = await validateLocations(
    options.sourceHome,
    options.targetHome,
  )
  await assertEmptyTarget(locations.targetHome)
  const normalized = { ...options, ...locations }
  const warnings = await assertImportSourceStopped(normalized)
  const profiles = await inspectProfiles(locations.sourceHome)
  const expected =
    options.source === 'next'
      ? ['dsh-desktop-next']
      : ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']
  if (
    !profiles.some((profile) =>
      profile.bundles.some((bundle) => expected.includes(bundle)),
    )
  ) {
    throw new DesktopImportError(
      'source-mismatch',
      '目录中没有所选来源的桌面 Profile，请检查数据来源与实际 Home。',
    )
  }
  let active = options.activeProfile
  if (active === undefined && options.source === 'next') {
    try {
      const saved = await readImportJson(
        join(locations.sourceHome, 'desktop-next.json'),
      )
      if (typeof saved.active === 'string') active = saved.active
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  active ??=
    profiles.find((profile) => profile.name === 'desktop')?.name ??
    profiles[0]!.name
  if (
    !validProfileName(active) ||
    !profiles.some((profile) => profile.name === active)
  )
    throw new DesktopImportError(
      'invalid-profile',
      '选中的 Profile 不存在于源数据中。',
    )
  const skippedPaths: string[] = []
  const files = await treeFiles(locations.sourceHome, skippedPaths)
  let totalBytes = 0
  for (const path of files) {
    checkAbort(options.signal)
    totalBytes += (await lstat(join(locations.sourceHome, ...path.split('/'))))
      .size
  }
  options.onProgress?.({
    phase: 'inspect',
    completed: files.length,
    total: files.length,
  })
  return {
    ...locations,
    source: options.source,
    profiles,
    activeProfile: active,
    fileCount: files.length,
    totalBytes,
    skippedPaths,
    warnings,
    reauthorization,
  }
}

interface Receipt {
  version: 1
  transactionId: string
  sourceHome: string
  targetHome: string
  source: 'desktop' | 'next'
  backupPath: string
  targetOriginallyExisted: boolean
  createdAt: string
  fingerprint: string
  fileCount: number
}
function transactionPath(target: string, id: string): string {
  return join(dirname(target), `.${basename(target)}.import-${id}`)
}
async function transactionLock(target: string): Promise<() => Promise<void>> {
  const path = join(dirname(target), `.${basename(target)}.import.lock`)
  try {
    const file = await open(path, 'wx', 0o600)
    await file.writeFile(String(process.pid))
    await file.close()
  } catch {
    throw new DesktopImportError(
      'target-locked',
      '已有导入操作或未处理的导入锁，请先检查上一次操作。',
    )
  }
  return async () => {
    await unlink(path)
  }
}
async function copySnapshot(
  from: string,
  to: string,
  phase: 'backup' | 'copy',
  options: DesktopImportOptions,
): Promise<ImportFile[]> {
  const files = await treeFiles(from)
  const snapshot: ImportFile[] = []
  for (const path of files) {
    snapshot.push(await digestFile(from, path, to, options.signal))
    options.onProgress?.({
      phase,
      completed: snapshot.length,
      total: files.length,
    })
  }
  return snapshot
}

export async function importDesktopData(
  options: ExecuteDesktopImportOptions,
): Promise<DesktopImportResult> {
  if (typeof options.installDependencies !== 'function')
    throw new DesktopImportError(
      'installer-required',
      '导入需要应用提供隔离的依赖安装器。',
    )
  const plan = await inspectDesktopImport(options)
  const normalized = {
    ...options,
    sourceHome: plan.sourceHome,
    targetHome: plan.targetHome,
  }
  const release = await transactionLock(plan.targetHome)
  const id = randomUUID()
  const transaction = transactionPath(plan.targetHome, id)
  const backup = join(transaction, 'backup')
  const stage = join(transaction, 'stage')
  const empty = join(transaction, 'empty-target')
  let movedEmpty = false
  let published = false
  try {
    const targetOriginallyExisted = await assertEmptyTarget(plan.targetHome)
    await mkdir(transaction, { mode: 0o700 })
    await mkdir(backup, { mode: 0o700 })
    await mkdir(stage, { mode: 0o700 })
    const original = await copySnapshot(
      plan.sourceHome,
      backup,
      'backup',
      normalized,
    )
    if (
      !sameFiles(original, await fingerprint(plan.sourceHome, options.signal))
    )
      throw new DesktopImportError(
        'source-changed',
        '备份期间源数据发生变化，请退出旧应用后重试。',
      )
    const copied = await copySnapshot(backup, stage, 'copy', normalized)
    if (!sameFiles(original, copied))
      throw new DesktopImportError('backup-mismatch', '备份复制校验失败。')
    options.onProgress?.({
      phase: 'profiles',
      completed: 0,
      total: plan.profiles.length,
    })
    plan.warnings.push(
      ...(await convertImportedProfiles(
        stage,
        plan.profiles,
        plan.activeProfile,
      )),
    )
    checkAbort(options.signal)
    await assertImportSourceStopped(normalized)
    if (
      !sameFiles(original, await fingerprint(plan.sourceHome, options.signal))
    )
      throw new DesktopImportError(
        'source-changed',
        '导入期间源数据发生变化；目标尚未启用，请重试。',
      )
    await writeFile(
      join(stage, IMPORT_PENDING),
      json({ transactionId: id, backupPath: backup }),
      { flag: 'wx', mode: 0o600 },
    )
    options.onProgress?.({ phase: 'publish', completed: 0, total: 1 })
    checkAbort(options.signal)
    const existedNow = await assertEmptyTarget(plan.targetHome)
    if (existedNow !== targetOriginallyExisted)
      throw new DesktopImportError(
        'target-changed',
        '目标目录状态已经改变，请重试。',
      )
    if (targetOriginallyExisted) {
      await rename(plan.targetHome, empty)
      movedEmpty = true
      if ((await readdir(empty)).length)
        throw new DesktopImportError(
          'target-changed',
          '目标目录在发布前被写入，导入已停止。',
        )
    }
    await rename(stage, plan.targetHome)
    published = true
    // pnpm on Windows creates absolute junctions. Install at the final path,
    // while the pending marker and import lock still prevent backend activation.
    options.onProgress?.({
      phase: 'dependencies',
      completed: 0,
      total: plan.profiles.length,
    })
    await options.installDependencies({
      home: plan.targetHome,
      profiles: plan.profiles.map((profile) => ({
        name: profile.name,
        directory: join(plan.targetHome, 'profiles', profile.name),
      })),
      ignoreScripts: true,
      signal: options.signal,
    })
    checkAbort(options.signal)
    await assertImportSourceStopped(normalized)
    if (
      !sameFiles(original, await fingerprint(plan.sourceHome, options.signal))
    )
      throw new DesktopImportError(
        'source-changed',
        '安装依赖期间源数据发生变化，导入已回退。',
      )
    const files = await fingerprint(plan.targetHome, options.signal)
    const receipt: Receipt = {
      version: 1,
      transactionId: id,
      sourceHome: plan.sourceHome,
      targetHome: plan.targetHome,
      source: plan.source,
      backupPath: backup,
      targetOriginallyExisted,
      createdAt: new Date().toISOString(),
      fingerprint: snapshotDigest(files),
      fileCount: files.length,
    }
    await writeFile(join(transaction, 'receipt.json'), json(receipt), {
      flag: 'wx',
      mode: 0o600,
    })
    await writeFile(join(plan.targetHome, RECEIPT), json(receipt), {
      flag: 'wx',
      mode: 0o600,
    })
    await unlink(join(plan.targetHome, IMPORT_PENDING))
    return {
      ...plan,
      transactionId: id,
      backupPath: backup,
      receiptPath: join(plan.targetHome, RECEIPT),
    }
  } catch (error) {
    if (published) {
      try {
        await rename(plan.targetHome, join(transaction, 'failed-home'))
        published = false
      } catch {
        /* Leave the pending marker in place; never delete a failed imported Home. */
      }
    }
    if (movedEmpty && !published) {
      try {
        await rename(empty, plan.targetHome)
      } catch {
        /* Preserve both directories for manual recovery. */
      }
    }
    const failure = new DesktopImportError(
      error instanceof DesktopImportError ? error.code : 'import-failed',
      error instanceof Error ? error.message : '导入失败。',
      backup,
    )
    try {
      await writeFile(
        join(transaction, 'failure.json'),
        json({
          code: failure.code,
          backupPath: backup,
          sourceUnchangedByImporter: true,
        }),
        { flag: 'wx', mode: 0o600 },
      )
    } catch {
      /* Creating the transaction itself may have failed. */
    }
    throw failure
  } finally {
    await release()
  }
}

/** Rollback moves the imported Home aside; it never deletes imported data or writes to the source. */
export async function rollbackDesktopImport(
  options: RollbackDesktopImportOptions,
): Promise<{ archivedHome: string; sourceHome: string }> {
  checkAbort(options.signal)
  const target = canonicalPath(options.targetHome)
  await assertRealPath(target)
  await options.assertTargetStopped()
  const release = await transactionLock(target)
  try {
    const value = await readImportJson(join(target, RECEIPT))
    if (
      value.version !== 1 ||
      typeof value.transactionId !== 'string' ||
      !/^[0-9a-f-]{36}$/u.test(value.transactionId) ||
      value.targetHome !== target ||
      typeof value.sourceHome !== 'string' ||
      typeof value.targetOriginallyExisted !== 'boolean' ||
      typeof value.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.fingerprint)
    ) {
      throw new DesktopImportError(
        'invalid-receipt',
        '导入凭据无效，不能自动回退。',
      )
    }
    const transaction = transactionPath(target, value.transactionId)
    await assertRealPath(transaction)
    const saved = await readImportJson(join(transaction, 'receipt.json'))
    if (JSON.stringify(saved) !== JSON.stringify(value))
      throw new DesktopImportError(
        'invalid-receipt',
        '导入凭据与备份记录不一致。',
      )
    if (
      value.fingerprint !==
      snapshotDigest(await fingerprint(target, options.signal))
    )
      throw new DesktopImportError(
        'target-changed',
        '导入后业务数据已经改变；请保留当前目录并手动选择旧数据目录。',
      )
    await options.assertTargetStopped()
    checkAbort(options.signal)
    const archivedHome = join(transaction, 'rolled-back-home')
    await rename(target, archivedHome)
    if (value.targetOriginallyExisted)
      await rename(join(transaction, 'empty-target'), target)
    await writeFile(
      join(transaction, 'rollback.json'),
      json({ createdAt: new Date().toISOString(), archivedHome }),
      { flag: 'wx', mode: 0o600 },
    )
    return { archivedHome, sourceHome: value.sourceHome }
  } finally {
    await release()
  }
}
