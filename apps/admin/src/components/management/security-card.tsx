'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { managementApi, type LoginSession } from '@/features/management/api'
import { beginSessionSignOut } from '@/features/auth/session'
import { ManagementDialog, ManagementPagination } from './presentation'
import {
  dateLabel,
  ResourceState,
  useManagementResource,
  useManagementText,
} from './controls'

export function SecurityCard() {
  const tr = useManagementText()
  const { navigate, session: account } = useAuth()
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const resource = useManagementResource(
    `login-sessions:${page}:${pageSize}`,
    () => managementApi.sessions(page, '', pageSize),
    { autoRefreshMs: 15000, enabled: Boolean(account?.userId) },
  )
  const [recovery, setRecovery] = React.useState<{
    userId: string
    codes: string[]
  } | null>(null)
  const codes =
    recovery && recovery.userId === account?.userId ? recovery.codes : []
  const [confirmation, setConfirmation] = React.useState<
    | { kind: 'session'; session: LoginSession }
    | { kind: 'all' | 'recovery' }
    | null
  >(null)
  React.useEffect(() => {
    setConfirmation(null)
    setRecovery(null)
    setPage(1)
  }, [account?.userId])
  const total = resource.data?.total ?? resource.data?.sessions.length ?? 0
  React.useEffect(() => {
    if (resource.data)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(total / pageSize))),
      )
  }, [resource.data, total, pageSize])
  const leave = () => {
    void beginSessionSignOut()
    navigate('signed-out')
  }
  const confirm = async () => {
    if (!confirmation || resource.busy) return
    const current = confirmation
    let generated: string[] = []
    const success = await resource.perform(async () => {
      if (current.kind === 'session')
        await managementApi.revokeSession(current.session.id)
      else if (current.kind === 'all') await managementApi.revokeAll()
      else generated = (await managementApi.recoveryCodes()).codes
    })
    if (!success) return
    setConfirmation(null)
    if (
      current.kind === 'all' ||
      (current.kind === 'session' && current.session.current)
    )
      leave()
    if (current.kind === 'recovery' && account?.userId)
      setRecovery({ userId: account.userId, codes: generated })
  }
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">
          {tr('登录会话与账号恢复', 'Sign-in sessions and recovery')}
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={resource.loading || resource.busy}
          onClick={resource.reload}
        >
          {tr('刷新', 'Refresh')}
        </Button>
      </div>
      <ResourceState {...resource} onRetry={resource.reload} />
      <div className="divide-y">
        {resource.data?.sessions.map((session) => (
          <div
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p className="text-sm font-medium">
                {session.clientName || tr('浏览器或设备', 'Browser or device')}
                {session.current && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {tr('当前会话', 'Current session')}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {tr('最近使用', 'Last used')}: {dateLabel(session.lastSeenAt)} ·{' '}
                {tr('有效期至', 'Expires')}: {dateLabel(session.expiresAt)}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={resource.busy}
              onClick={() => setConfirmation({ kind: 'session', session })}
            >
              {tr('撤销', 'Revoke')}
            </Button>
          </div>
        ))}
      </div>
      {!resource.loading && !resource.error && total === 0 && (
        <p className="py-4 text-sm text-muted-foreground">
          {tr('暂无登录会话', 'No sign-in sessions')}
        </p>
      )}
      <ManagementPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        loading={resource.loading || resource.busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          disabled={resource.busy}
          onClick={() => setConfirmation({ kind: 'all' })}
        >
          {tr('退出全部登录会话', 'Sign out everywhere')}
        </Button>
        <Button
          variant="outline"
          disabled={resource.busy}
          onClick={() => setConfirmation({ kind: 'recovery' })}
        >
          {tr('生成恢复码', 'Generate recovery codes')}
        </Button>
      </div>
      <ManagementDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={
          confirmation?.kind === 'recovery'
            ? tr('生成恢复码', 'Generate recovery codes')
            : tr('撤销登录', 'Revoke sign-in')
        }
        description={
          confirmation?.kind === 'recovery'
            ? tr(
                '生成新恢复码后，旧恢复码将失效。请保存本次生成的恢复码。',
                'Previous recovery codes will become invalid. Save the newly generated codes.',
              )
            : confirmation?.kind === 'all'
              ? tr(
                  '所有设备都需要重新登录，包括当前浏览器。已提交的服务端任务继续运行。',
                  'All devices, including this browser, must sign in again. Submitted server tasks continue running.',
                )
              : tr(
                  '该登录客户端需要重新登录。此操作不删除设备、会话和聊天记录。',
                  'This client will need to sign in again. Devices, conversations and history are retained.',
                )
        }
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy}
              onClick={() => setConfirmation(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant={
                confirmation?.kind === 'recovery' ? 'default' : 'destructive'
              }
              disabled={resource.busy}
              onClick={() => void confirm()}
            >
              {tr('确认', 'Confirm')}
            </Button>
          </>
        }
      >
        {confirmation?.kind === 'session' && (
          <p className="text-sm">{confirmation.session.clientName}</p>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={codes.length > 0}
        onOpenChange={(open) => {
          if (!open) setRecovery(null)
        }}
        title={tr('保存恢复码', 'Save recovery codes')}
        footer={
          <Button onClick={() => setRecovery(null)}>
            {tr('已保存，隐藏恢复码', 'Saved — hide codes')}
          </Button>
        }
      >
        <div className="space-y-3 rounded-lg bg-muted p-4">
          <p className="text-sm font-medium">
            {tr(
              '仅显示本次。请将恢复码保存在安全位置；每个码只能使用一次。',
              'Shown only now. Store these codes securely; each can be used once.',
            )}
          </p>
          <pre className="select-all whitespace-pre-wrap font-mono text-sm">
            {codes.join('\n')}
          </pre>
        </div>
      </ManagementDialog>
    </section>
  )
}
