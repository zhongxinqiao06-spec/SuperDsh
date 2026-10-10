'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { managementApi } from '@/features/management/api'
import { beginSessionSignOut } from '@/features/auth/session'
import {
  dateLabel,
  ResourceState,
  useManagementResource,
  useManagementText,
} from './controls'

export function SecurityCard() {
  const tr = useManagementText()
  const { navigate, session: account } = useAuth()
  const resource = useManagementResource(
    'login-sessions',
    managementApi.sessions,
    { autoRefreshMs: 15000, enabled: Boolean(account?.userId) },
  )
  const [recovery, setRecovery] = React.useState<{
    userId: string
    codes: string[]
  } | null>(null)
  const codes =
    recovery && recovery.userId === account?.userId ? recovery.codes : []
  const leave = () => {
    void beginSessionSignOut()
    navigate('signed-out')
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
              onClick={() => {
                if (
                  window.confirm(
                    tr('撤销此登录会话？', 'Revoke this sign-in session?'),
                  )
                )
                  void resource
                    .perform(() => managementApi.revokeSession(session.id))
                    .then((success) => {
                      if (success && session.current) leave()
                    })
              }}
            >
              {tr('撤销', 'Revoke')}
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          disabled={resource.busy}
          onClick={() => {
            if (
              window.confirm(
                tr('退出所有设备上的登录会话？', 'Sign out of all devices?'),
              )
            )
              void resource.perform(managementApi.revokeAll).then((success) => {
                if (success) leave()
              })
          }}
        >
          {tr('退出全部登录会话', 'Sign out everywhere')}
        </Button>
        <Button
          variant="outline"
          disabled={resource.busy}
          onClick={() => {
            if (
              window.confirm(
                tr(
                  '生成新恢复码后，旧恢复码将失效。继续？',
                  'Generating recovery codes invalidates previous codes. Continue?',
                ),
              )
            ) {
              let generated: string[] = []
              void resource
                .perform(async () => {
                  generated = (await managementApi.recoveryCodes()).codes
                })
                .then((success) => {
                  if (success && account?.userId)
                    setRecovery({ userId: account.userId, codes: generated })
                })
            }
          }}
        >
          {tr('生成恢复码', 'Generate recovery codes')}
        </Button>
      </div>
      {codes.length > 0 && (
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
          <Button variant="outline" onClick={() => setRecovery(null)}>
            {tr('已保存，隐藏恢复码', 'Saved — hide codes')}
          </Button>
        </div>
      )}
    </section>
  )
}
