'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { authApi } from '@/features/auth/api'
import { AuthShell } from './auth-shell'
import { useAuth } from './auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldLabel, useManagementText } from '@/components/management/controls'

export function RequiredPasswordChange() {
  const { session, signOut } = useAuth()
  const tr = useManagementText()
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  return (
    <AuthShell>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!session) return
          setBusy(true)
          setError('')
          void authApi
            .changePassword(session.accessToken, { newPassword: password })
            .then(() => {
              setPassword('')
              setConfirm('')
              toast.success(
                tr(
                  '密码已更新，请重新登录。',
                  'Password updated. Please sign in again.',
                ),
              )
              signOut()
            })
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setBusy(false))
        }}
      >
        <h1 className="text-2xl font-semibold">
          {tr('请设置自己的密码', 'Set your own password')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {tr(
            '首次使用管理员创建的账号，需要更换初始密码后才能进入工作台。',
            'Before using an administrator-created account, replace its initial password to enter your workspace.',
          )}
        </p>
        <FieldLabel title={tr('新密码', 'New password')}>
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FieldLabel>
        <FieldLabel title={tr('确认新密码', 'Confirm new password')}>
          <Input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </FieldLabel>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          className="w-full"
          type="submit"
          disabled={busy || !password || password !== confirm}
        >
          {tr('保存并重新登录', 'Save and sign in again')}
        </Button>
        <Button
          className="w-full"
          type="button"
          variant="outline"
          disabled={busy}
          onClick={signOut}
        >
          {tr('退出登录', 'Sign out')}
        </Button>
      </form>
    </AuthShell>
  )
}
