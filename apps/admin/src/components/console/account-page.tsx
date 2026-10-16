'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { useManagementText } from '@/components/management/controls'
import { ModelsPanel } from '@/components/management/models-panel'
import { MobileConnectionsPage } from '@/components/pages/mobile-connections-page'
import { PageHeader } from '@/components/pages/page-header'
import { cn } from '@/lib/utils'
import {
  AccountSecuritySection,
  AccountTab,
  AppearanceTab,
} from '@/components/pages/settings-page'

export type AccountSection =
  'profile' | 'security' | 'models' | 'appearance' | 'mobile'

export function AccountPage({ section }: { section: AccountSection }) {
  const tr = useManagementText()
  const { session, me, refreshMe, can } = useAuth()
  const [profile, setProfile] = React.useState(me)
  React.useEffect(() => setProfile(me), [me])
  if (section === 'mobile') return <MobileConnectionsPage />
  const titles = {
    profile: tr('个人资料', 'My profile'),
    security: tr('账号安全与登录记录', 'Account security and sign-ins'),
    models: tr('个人模型', 'Personal models'),
    appearance: tr('外观与语言', 'Appearance and language'),
  }
  return (
    <div
      className={
        section === 'models'
          ? 'flex min-h-0 min-w-0 flex-1 flex-col'
          : 'h-full overflow-y-auto'
      }
    >
      <div
        className={cn(
          'mx-auto w-full max-w-6xl p-4 sm:p-8',
          section === 'models'
            ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-6'
            : 'space-y-6',
        )}
      >
        <PageHeader title={titles[section]} />
        {section === 'profile' && profile && session && (
          <AccountTab
            key={session.userId}
            me={profile}
            token={session.accessToken}
            showSecurity={false}
            onMeChange={(value) => {
              setProfile(value)
              void refreshMe().catch(() => undefined)
            }}
          />
        )}
        {section === 'security' && session && (
          <AccountSecuritySection token={session.accessToken} />
        )}
        {section === 'models' && can('models.personal.manage') && (
          <ModelsPanel key={session?.userId} scope="personal" />
        )}
        {section === 'appearance' && <AppearanceTab />}
      </div>
    </div>
  )
}
