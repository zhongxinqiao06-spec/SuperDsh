/** Account choice inside the model credential onboarding step. */
import { useEffect, useState } from 'react'
import { platformBridge } from '@superdsh/core/client/platform'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignInDialog } from './SignInDialog.tsx'

/** @param props - onboarding completion, account state and actions. @returns account dialog while signed out. */
export function AccountOnboarding({
  complete,
  useApiKey: chooseApiKey,
  useAccount,
  useTheme,
  setOnboarding,
  showLogin,
  start,
  cancel,
  t,
}: PropsRuntime<'settings.models.sign-in'> &
  PropsLocale<'settings.account'> &
  InjectFace<AccountSectionInjected>) {
  const account = useAccount((value) => value)
  const [deepseek, setDeepseek] = useState(false)
  const colorScheme = useTheme((snapshot) => snapshot.active.colorScheme)
  useEffect(() => {
    setOnboarding(true)
    return () => {
      setOnboarding(false)
    }
  }, [setOnboarding])
  useEffect(() => {
    if (account.view?.status === 'credential-stored') complete()
  }, [account.view?.status, complete])
  if (!account.view || account.view.status === 'credential-stored') return null
  if (!deepseek && platformBridge())
    return (
      <Modal
        className="platformLoginChoice"
        open
        title="选择登录方式"
        description="欢迎使用 SuperDsh。DeepSeek 登录用于模型授权；平台登录用于自己的设备和平台模型。"
        closeLabel="暂时跳过"
        onClose={() => {
          showLogin(false)
          complete()
        }}
      >
        <div className="platformLoginChoices">
          <Button variant="primary" onClick={() => setDeepseek(true)}>
            登录 DeepSeek
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              showLogin(false)
              complete()
              window.dispatchEvent(new CustomEvent('superdsh:platform-open'))
            }}
          >
            登录管理平台
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              showLogin(false)
              chooseApiKey()
            }}
          >
            配置模型密钥
          </Button>
          <Button
            onClick={() => {
              showLogin(false)
              complete()
            }}
          >
            暂时跳过
          </Button>
        </div>
      </Modal>
    )
  return (
    <SignInDialog
      account={account}
      colorScheme={colorScheme}
      start={start}
      cancel={cancel}
      t={t}
      close={() => {
        showLogin(false)
        complete()
      }}
      useApiKey={() => {
        showLogin(false)
        chooseApiKey()
      }}
    />
  )
}
