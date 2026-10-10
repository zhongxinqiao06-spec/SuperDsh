import type { ReactElement } from 'react'

export interface ImportWizardPlan {
  source: 'desktop' | 'next'
  sourceHome: string
  targetHome: string
  profiles: readonly { name: string }[]
  activeProfile: string
  fileCount: number
  totalBytes: number
  skippedPaths: readonly string[]
  warnings: readonly { code: string; message: string; path?: string }[]
  reauthorization: readonly string[]
}
/** Controlled view only: no filesystem, Electron, network or backend imports. */
export interface ImportWizardProps {
  source: 'desktop' | 'next'
  sourceHome: string
  targetHome: string
  onSourceChange: (source: 'desktop' | 'next') => void
  onSourceHomeChange: (path: string) => void
  onTargetHomeChange?: (path: string) => void
  onBrowseSource?: () => void
  onInspect: () => void
  onImport: () => void
  onCancel?: () => void
  onClose: () => void
  onUseImported?: () => void
  onRollback?: () => void
  busy?: boolean
  plan?: ImportWizardPlan
  progress?: { phase: string; completed: number; total: number }
  result?: {
    targetHome: string
    backupPath: string
    warnings?: readonly { code: string; message: string }[]
  }
  error?: string
}
const phases: Record<string, string> = {
  inspect: '检查源数据',
  backup: '建立只读源数据的副本',
  copy: '准备新数据目录',
  profiles: '转换 Profile',
  publish: '准备目标目录',
  dependencies: '安装 Profile 依赖',
}
const field =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
const button =
  'rounded-md border border-input px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50'
const primary = `${button} bg-primary text-primary-foreground`
function bytes(value: number): string {
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`
}
function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const value = path.replaceAll('\\', '/').replace(/\/+$/u, '')
    return /^[a-z]:\//iu.test(value) ? value.toLowerCase() : value
  }
  return normalize(left) === normalize(right)
}

export function ImportWizard(props: ImportWizardProps): ReactElement {
  const { plan, result, busy = false } = props
  const current =
    plan?.source === props.source &&
    samePath(plan.sourceHome, props.sourceHome) &&
    samePath(plan.targetHome, props.targetHome)
  return (
    <section
      aria-labelledby="superdsh-import-title"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-6 text-foreground"
    >
      <header>
        <h1 id="superdsh-import-title" className="text-xl font-semibold">
          导入已有桌面数据
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          复制主桌面或 Next 的
          Profile、会话与设置到一个新的空目录。请先完全退出来源应用及其后台服务。
        </p>
      </header>
      {!result && (
        <fieldset disabled={busy} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            数据来源
            <select
              className={field}
              value={props.source}
              onChange={(event) =>
                props.onSourceChange(event.target.value as 'desktop' | 'next')
              }
            >
              <option value="desktop">DSH 主桌面</option>
              <option value="next">DSH NEXT</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            源数据目录（Harness Home）
            <span className="flex gap-2">
              <input
                className={field}
                value={props.sourceHome}
                onChange={(event) =>
                  props.onSourceHomeChange(event.target.value)
                }
                spellCheck={false}
                placeholder={
                  props.source === 'desktop'
                    ? '例如 C:\\Users\\用户名\\.dsh'
                    : '选择 DSH NEXT 的 home 目录'
                }
              />
              {props.onBrowseSource && (
                <button
                  type="button"
                  className={`${button} shrink-0`}
                  onClick={props.onBrowseSource}
                >
                  选择目录
                </button>
              )}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            新 SuperDsh 数据目录
            <input
              className={field}
              value={props.targetHome}
              readOnly={!props.onTargetHomeChange}
              onChange={(event) =>
                props.onTargetHomeChange?.(event.target.value)
              }
              spellCheck={false}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            源目录保持不变。依赖会重新安装，缓存、日志、旧运行锁与远控绑定不启用。使用其他数据目录的用户，请选择实际位置。
          </p>
        </fieldset>
      )}
      {!result && current && plan && (
        <section
          aria-label="导入预览"
          className="rounded-lg border p-4 text-sm"
        >
          <h2 className="font-medium">
            可以导入 {plan.profiles.length} 个 Profile
          </h2>
          <p className="mt-2">
            {plan.fileCount} 个文件，约 {bytes(plan.totalBytes)}；默认打开{' '}
            {plan.activeProfile}。
          </p>
          <p className="mt-1 break-words text-muted-foreground">
            {plan.profiles.map((profile) => profile.name).join('、')}
          </p>
          <h3 className="mt-4 font-medium">导入后需要重新确认授权</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {plan.reauthorization.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          {plan.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {plan.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          )}
          {plan.skippedPaths.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer">
                查看 {plan.skippedPaths.length} 项跳过内容
              </summary>
              <ul className="mt-2 max-h-36 overflow-auto text-xs">
                {plan.skippedPaths.map((path) => (
                  <li className="break-all" key={path}>
                    {path}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {busy && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border p-3 text-sm"
        >
          <p>{phases[props.progress?.phase ?? 'inspect'] ?? '正在导入'}…</p>
          {props.progress && props.progress.total > 0 && (
            <progress
              className="mt-2 w-full"
              max={props.progress.total}
              value={props.progress.completed}
              aria-label="导入进度"
            />
          )}
          <p className="mt-1 text-muted-foreground">
            完成前请保持来源应用关闭。依赖安装可能需要一些时间。
          </p>
        </div>
      )}
      {props.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {props.error}
        </p>
      )}
      {result && (
        <section role="status" className="rounded-lg border p-4 text-sm">
          <h2 className="font-medium">数据已导入</h2>
          <p className="mt-2 break-all">新目录：{result.targetHome}</p>
          <p className="mt-2 break-all text-muted-foreground">
            备份保留在：{result.backupPath}
          </p>
          <p className="mt-3">
            旧应用的数据保持原样。进入新环境后，请确认模型服务授权，并重新登录远控服务。
          </p>
          {result.warnings && result.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {result.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <footer className="flex flex-wrap justify-end gap-2">
        {busy ? (
          props.onCancel && (
            <button type="button" className={button} onClick={props.onCancel}>
              取消导入
            </button>
          )
        ) : (
          <>
            <button type="button" className={button} onClick={props.onClose}>
              {result ? '关闭' : '暂不导入'}
            </button>
            {!result && (
              <button
                type="button"
                className={current ? button : primary}
                disabled={!props.sourceHome || !props.targetHome}
                onClick={props.onInspect}
              >
                检查数据
              </button>
            )}
            {!result && current && (
              <button
                type="button"
                className={primary}
                onClick={props.onImport}
              >
                开始导入
              </button>
            )}
            {result && props.onRollback && (
              <button
                type="button"
                className={button}
                onClick={props.onRollback}
              >
                回退本次导入
              </button>
            )}
            {result && props.onUseImported && (
              <button
                type="button"
                className={primary}
                onClick={props.onUseImported}
              >
                进入导入的数据
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  )
}
