'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldLabel, useManagementText } from '@/components/management/controls'
import { managementApi } from '@/features/management/api'
import { useAuth } from './auth-context'

export function RecoveryDialog() {
  const tr = useManagementText()
  const { emailVerificationRequired } = useAuth()
  const [mode, setMode] = React.useState<'code' | 'email'>('code')
  const [cooldown, setCooldown] = React.useState(0)
  React.useEffect(() => {
    if (!cooldown) return
    const timer = window.setTimeout(
      () => setCooldown((value) => value - 1),
      1000,
    )
    return () => window.clearTimeout(timer)
  }, [cooldown])
  const [open, setOpen] = React.useState(false)
  const [identifier, setIdentifier] = React.useState('')
  const [recoveryCode, setCode] = React.useState('')
  const [newPassword, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [done, setDone] = React.useState(false)
  const reset = () => {
    setCode('')
    setPassword('')
    setConfirm('')
    setError('')
    setDone(false)
  }
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    const request =
      mode === 'email'
        ? managementApi.recoverEmail({
            email: identifier.trim().toLowerCase(),
            code: recoveryCode.trim(),
            newPassword,
          })
        : managementApi.recover({
            identifier: identifier.trim(),
            recoveryCode: recoveryCode.trim(),
            newPassword,
          })
    void request
      .then(() => {
        setCode('')
        setPassword('')
        setConfirm('')
        setDone(true)
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false))
  }
  const sendCode = () => {
    setBusy(true)
    setError('')
    void managementApi
      .recoveryEmailCode(identifier.trim().toLowerCase())
      .then((result) => setCooldown(result.retryAfter || 60))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Button
        variant="link"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        {tr('找回账号 / 重置密码', 'Recover account / reset password')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value)
            if (!value) reset()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr('恢复账号', 'Recover account')}</DialogTitle>
            <DialogDescription>
              {tr(
                '使用本人预先保存的恢复码，或已验证邮箱。重置会撤销现有登录会话。',
                'Use a saved recovery code or your verified email. Resetting revokes existing sign-in sessions.',
              )}
            </DialogDescription>
          </DialogHeader>
          {done ? (
            <p role="status">
              {tr(
                '密码已重置，请使用新密码登录。',
                'Password reset. Sign in with your new password.',
              )}
            </p>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              {emailVerificationRequired && (
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    type="button"
                    variant={mode === 'code' ? 'default' : 'outline'}
                    onClick={() => {
                      reset()
                      setMode('code')
                    }}
                  >
                    {tr('恢复码', 'Recovery code')}
                  </Button>
                  <Button
                    disabled={busy}
                    type="button"
                    variant={mode === 'email' ? 'default' : 'outline'}
                    onClick={() => {
                      reset()
                      setMode('email')
                    }}
                  >
                    {tr('邮箱验证码', 'Email verification')}
                  </Button>
                </div>
              )}
              <FieldLabel
                title={
                  mode === 'email'
                    ? tr('已验证邮箱', 'Verified email')
                    : tr('用户名或邮箱', 'Username or email')
                }
              >
                <Input
                  required
                  type={mode === 'email' ? 'email' : 'text'}
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                />
              </FieldLabel>
              <FieldLabel
                title={
                  mode === 'email'
                    ? tr('邮箱验证码', 'Email code')
                    : tr('恢复码', 'Recovery code')
                }
              >
                <Input
                  required
                  autoComplete="one-time-code"
                  value={recoveryCode}
                  onChange={(event) => setCode(event.target.value)}
                />
              </FieldLabel>
              {mode === 'email' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || cooldown > 0 || !identifier.includes('@')}
                  onClick={sendCode}
                >
                  {cooldown ? `${cooldown}s` : tr('发送验证码', 'Send code')}
                </Button>
              )}
              <FieldLabel title={tr('新密码', 'New password')}>
                <Input
                  required
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </FieldLabel>
              <FieldLabel title={tr('确认新密码', 'Confirm new password')}>
                <Input
                  required
                  type="password"
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
                disabled={busy || !newPassword || newPassword !== confirm}
                type="submit"
              >
                {tr('重置密码', 'Reset password')}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
