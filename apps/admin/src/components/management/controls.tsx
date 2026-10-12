'use client'

import * as React from 'react'
import { useLocale } from 'next-intl'
import { Button } from '@/components/ui/button'
import { loadStoredSession, subscribeSession } from '@/features/auth/session'

export function useManagementText() {
  const locale = useLocale()
  return React.useCallback(
    (zh: string, en: string) => (locale.startsWith('zh') ? zh : en),
    [locale],
  )
}

export function useManagementResource<T>(
  key: string,
  load: () => Promise<T>,
  options: { autoRefreshMs?: number; enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true
  const session = React.useSyncExternalStore(
    subscribeSession,
    loadStoredSession,
    () => null,
  )
  const scope = JSON.stringify([
    key,
    session?.userId ?? null,
    session?.authzVersion ?? 0,
  ])
  const loader = React.useRef(load)
  loader.current = load
  const currentScope = React.useRef(scope)
  currentScope.current = scope
  const pendingLoad = React.useRef(false)
  const mounted = React.useRef(false)
  const actionSequence = React.useRef(0)
  const [result, setResult] = React.useState<{
    scope: string
    data: T | null
    error: string
    loading: boolean
  }>({ scope, data: null, error: '', loading: true })
  const [operation, setOperation] = React.useState<{
    scope: string
    sequence: number
  } | null>(null)
  const [version, setVersion] = React.useState(0)
  const reload = React.useCallback(() => setVersion((value) => value + 1), [])
  const busy = operation?.scope === scope
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  React.useEffect(() => {
    let active = true
    if (!enabled) {
      pendingLoad.current = false
      setResult({ scope, data: null, error: '', loading: false })
      return
    }
    pendingLoad.current = true
    setResult((previous) => ({
      scope,
      data: previous.scope === scope ? previous.data : null,
      error: '',
      loading: true,
    }))
    const read = async () => {
      try {
        const data = await loader.current()
        if (active) setResult({ scope, data, error: '', loading: false })
      } catch (cause: unknown) {
        if (active)
          setResult((previous) => ({
            ...previous,
            error: cause instanceof Error ? cause.message : String(cause),
            loading: false,
          }))
      } finally {
        if (active) pendingLoad.current = false
      }
    }
    void read()
    return () => {
      active = false
    }
  }, [enabled, scope, version])
  React.useEffect(() => {
    if (!enabled || !options.autoRefreshMs || options.autoRefreshMs <= 0) return
    const refresh = () => {
      if (!document.hidden && !pendingLoad.current && !busy) reload()
    }
    const timer = window.setInterval(refresh, options.autoRefreshMs)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [options.autoRefreshMs, busy, enabled, reload, scope])
  const perform = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (!enabled || !mounted.current || currentScope.current !== scope)
      return false
    const sequence = ++actionSequence.current
    setOperation({ scope, sequence })
    setResult((previous) => ({ ...previous, error: '' }))
    try {
      await action()
      if (!mounted.current || currentScope.current !== scope) return false
      reload()
      return true
    } catch (cause) {
      if (mounted.current && currentScope.current === scope)
        setResult((previous) => ({
          ...previous,
          error: cause instanceof Error ? cause.message : String(cause),
        }))
      return false
    } finally {
      if (mounted.current)
        setOperation((current) =>
          current?.sequence === sequence ? null : current,
        )
    }
  }
  const matches = result.scope === scope
  return {
    data: enabled && matches ? result.data : null,
    error: enabled && matches ? result.error : '',
    loading: enabled && (!matches || result.loading),
    busy,
    reload,
    perform,
  }
}

export function ResourceState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean
  error: string
  onRetry: () => void
}) {
  const tr = useManagementText()
  return (
    <>
      {loading && (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          {tr('加载中…', 'Loading…')}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
        >
          <span className="flex-1">{error}</span>
          <Button variant="outline" onClick={onRetry}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}
    </>
  )
}

export function FieldLabel({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
      {title}
      {children}
    </label>
  )
}

export const tableClass =
  'w-full min-w-[640px] text-left text-sm [&_th]:whitespace-nowrap [&_th]:p-3 [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:p-3 [&_td]:align-top [&_tr]:border-b'

export function dateLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString()
}
