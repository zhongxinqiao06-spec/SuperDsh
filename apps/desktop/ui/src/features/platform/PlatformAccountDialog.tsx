import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'
import { PersonalModels } from './PersonalModels.tsx'

export function PlatformAccountDialog({
  model,
}: {
  model: PlatformWorkspaceModel
}) {
  const {
    bridge,
    account,
    origin,
    setOrigin,
    open,
    setOpen,
    busy,
    run,
    error,
  } = model
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  useEffect(() => {
    if (!open) {
      setPassword('')
      setNewPassword('')
    } else if (!origin) setOrigin(account?.origin ?? 'http://127.0.0.1:15174')
  }, [open, account?.origin, origin, setOrigin])
  if (!bridge) return null
  return (
    <Modal
      className="platformAccountDialog"
      open={open}
      onClose={() => setOpen(false)}
      closeLabel="关闭"
      title="SuperDsh 平台账号"
      description="登录仅改变平台连接，本机聊天、历史和个人模型继续保存在本地。"
    >
      {error && (
        <p role="alert" className="platformError">
          {error}
        </p>
      )}
      {account?.user && (
        <p className="platformAccountSummary">
          已登录：{account.user.displayName} · {account.user.username}
        </p>
      )}
      {account?.status === 'ready' &&
        !account.user?.resetRequired &&
        account.user?.permissions.includes('models.personal.manage') &&
        open && (
          <details className="platformAccountSummary">
            <summary>个人模型 · 服务端 Agent</summary>
            <PersonalModels
              key={`${account.identityKey}:${account.identityGeneration}`}
              model={model}
            />
          </details>
        )}
      {account?.user?.resetRequired ? (
        <form
          className="platformLoginForm"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const next = newPassword
              setNewPassword('')
              await bridge.changePassword({ newPassword: next })
              setPassword('')
            })
          }}
        >
          <p>请修改临时密码，随后使用新密码重新登录。</p>
          <label>
            新密码
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            修改密码
          </Button>
        </form>
      ) : (
        <form
          className="platformLoginForm"
          onSubmit={(event) => {
            event.preventDefault()
            const secret = password
            setPassword('')
            void run(async () => {
              await bridge.loginWithPassword({
                origin,
                identifier,
                password: secret,
              })
              const state = await bridge.state()
              if (state.user && !state.user.resetRequired) setOpen(false)
            })
          }}
        >
          <label>
            平台地址
            <Input
              type="url"
              autoComplete="url"
              required
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
            />
          </label>
          <label>
            用户名或邮箱
            <Input
              autoComplete="username"
              required
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </label>
          <label>
            密码
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy
              ? '正在连接…'
              : account?.user
                ? '切换账号并同步本地会话'
                : '登录并同步本地会话'}
          </Button>
          <p>
            当前本地会话内容会同步给登录账号；工作区文件和模型密钥不会整体上传。
          </p>
          <details>
            <summary>其他登录方式</summary>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => bridge.login(origin))
              }}
            >
              浏览器授权
            </Button>
          </details>
        </form>
      )}
      {account?.user && (
        <Button
          className="platformAccountSummary"
          type="button"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await bridge.logout()
              setOpen(false)
            })
          }}
        >
          退出平台账号
        </Button>
      )}
    </Modal>
  )
}
