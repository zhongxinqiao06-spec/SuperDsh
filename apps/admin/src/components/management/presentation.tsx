'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useManagementText } from './controls'

export function ManagementList({
  children,
  className,
  pagination,
}: {
  children: React.ReactNode
  className?: string
  pagination: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto overscroll-contain [&>*]:min-w-0 [&>*]:shrink-0',
          className,
        )}
      >
        {children}
      </div>
      <div className="shrink-0">{pagination}</div>
    </div>
  )
}

export function ManagementDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  busy = false,
  error,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children?: React.ReactNode
  footer?: React.ReactNode
  busy?: boolean
  error?: string
  className?: string
}) {
  const descriptionId = React.useId()
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent
        className={cn('max-h-[85svh] overflow-y-auto sm:max-w-2xl', className)}
        showCloseButton={!busy}
        aria-describedby={description ? descriptionId : undefined}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          {description && (
            <DialogDescription id={descriptionId}>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

export function ManagementPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  loading = false,
  className,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  loading?: boolean
  className?: string
}) {
  const tr = useManagementText()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total > 0 ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return (
    <nav
      aria-label={tr('列表分页', 'List pagination')}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm',
        className,
      )}
    >
      <p className="text-muted-foreground" aria-live="polite">
        {tr(`共 ${total} 条`, `${total} records`)}
        {total > 0 && ` · ${first}–${last}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange && (
          <label className="flex items-center gap-2 text-muted-foreground">
            {tr('每页', 'Per page')}
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-foreground"
              value={pageSize}
              disabled={loading}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {[10, 20, 50].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {tr('上一页', 'Previous')}
        </Button>
        <span>{tr(`第 ${page} / ${pages} 页`, `Page ${page} / ${pages}`)}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          {tr('下一页', 'Next')}
        </Button>
      </div>
    </nav>
  )
}

/** For complete, bounded catalogs. Growing histories use API pagination. */
export function useClientPagination<T>(items: T[], resetKey = '') {
  const [state, setState] = React.useState({
    key: resetKey,
    page: 1,
    pageSize: 10,
  })
  const pageSize = state.pageSize
  const total = items.length
  const page = Math.min(
    state.key === resetKey ? state.page : 1,
    Math.max(1, Math.ceil(total / pageSize)),
  )
  if (state.key !== resetKey || state.page !== page)
    setState({ key: resetKey, page, pageSize })
  const setPage = (value: number) =>
    setState({ key: resetKey, page: Math.max(1, value), pageSize })
  const setPageSize = (value: number) =>
    setState({ key: resetKey, page: 1, pageSize: value })
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
  }
}
