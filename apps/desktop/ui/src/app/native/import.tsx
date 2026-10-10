import { useEffect, useState } from 'react'
import { ImportWizard } from '../../features/import/ImportWizard.tsx'
import type {
  DesktopImportPlan,
  DesktopImportResult,
} from '@superdsh/core/contracts/import-types'
import type {
  ImportDefaults,
  ImportProgress,
  ImportSelection,
} from '@superdsh/core/contracts/import-contract'

export function ImportPage({ onClose }: { onClose(): void }) {
  const bridge = window.superdshImport
  const [defaults, setDefaults] = useState<ImportDefaults>()
  const [selection, setSelection] = useState<ImportSelection>({
    source: 'desktop',
    sourceHome: '',
    targetHome: '',
  })
  const [plan, setPlan] = useState<DesktopImportPlan>()
  const [result, setResult] = useState<DesktopImportResult>()
  const [progress, setProgress] = useState<ImportProgress>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!bridge) return
    let mounted = true
    void bridge
      .defaults()
      .then((value) => {
        if (!mounted) return
        setDefaults(value)
        setSelection(
          value.selection ?? {
            source: 'desktop',
            sourceHome: value.desktopHome,
            targetHome: value.targetHome,
          },
        )
        setPlan(value.plan)
        setResult(value.result)
        setError(value.error ?? '')
      })
      .catch((reason) => {
        if (mounted) setError(String(reason))
      })
      .finally(() => {
        if (mounted) setBusy(false)
      })
    const stop = bridge.onProgress((value) => {
      if (mounted) setProgress(value)
    })
    return () => {
      mounted = false
      stop()
    }
  }, [bridge])
  if (!bridge) return <p role="alert">导入工具不可用，请重新启动 SuperDsh。</p>
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const change = (value: Partial<ImportSelection>) => {
    setSelection((current) => ({ ...current, ...value }))
    setPlan(undefined)
    setResult(undefined)
    setError('')
  }
  return (
    <ImportWizard
      {...selection}
      plan={plan}
      result={result}
      progress={progress}
      busy={busy}
      error={error}
      onSourceChange={(source) =>
        change({
          source,
          sourceHome:
            source === 'desktop'
              ? (defaults?.desktopHome ?? '')
              : (defaults?.nextHome ?? ''),
        })
      }
      onSourceHomeChange={(sourceHome) => change({ sourceHome })}
      onBrowseSource={() => {
        void run(async () => {
          const sourceHome = await bridge.browse()
          if (sourceHome) change({ sourceHome })
        })
      }}
      onInspect={() => {
        void run(async () => {
          setPlan(undefined)
          const inspected = await bridge.inspect(selection)
          setSelection((current) => ({
            ...current,
            sourceHome: inspected.sourceHome,
          }))
          setPlan(inspected)
        })
      }}
      onImport={() => {
        void run(async () => {
          setResult(await bridge.execute(selection))
        })
      }}
      onCancel={() => {
        void bridge.cancel().catch((reason) => setError(String(reason)))
      }}
      onUseImported={() => {
        void run(() => bridge.useImported())
      }}
      onRollback={() => {
        void run(async () => {
          await bridge.rollback()
          setResult(undefined)
          setPlan(undefined)
        })
      }}
      onClose={onClose}
    />
  )
}
