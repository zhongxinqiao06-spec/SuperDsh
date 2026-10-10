'use client'

import * as React from 'react'
import { Eye, EyeOff, QrCode, RefreshCw, Smartphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useAuth } from '@/components/auth/auth-context'
import {
  dateLabel,
  useManagementResource,
} from '@/components/management/controls'
import { MobileConnectionDialog } from '@/components/pages/mobile-signin-panel'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { accountDisplayName } from '@/features/auth/account-profile'
import { beginSessionSignOut } from '@/features/auth/session'
import { managementApi, type LoginSession } from '@/features/management/api'
import { mobileLoginSessions } from '@/features/mobile-connections/login-sessions'
import { useMobileConnectionsSidebarVisibility } from '@/features/mobile-connections/sidebar-visibility'

export function MobileConnectionsPage() {
  const t = useTranslations('dashboard.mobileConnections')
  const { session, me, navigate } = useAuth()
  const [sidebarVisible, setSidebarVisible] =
    useMobileConnectionsSidebarVisibility()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const resource = useManagementResource(
    'mobile-login-sessions',
    managementApi.sessions,
    { autoRefreshMs: 15000, enabled: Boolean(session?.userId) },
  )
  const mobileSessions = mobileLoginSessions(resource.data?.sessions ?? [])

  React.useEffect(() => {
    setDialogOpen(false)
  }, [session?.userId])

  const revokeSession = (loginSession: LoginSession) => {
    if (!window.confirm(t('revokeConfirm'))) return
    void resource
      .perform(() => managementApi.revokeSession(loginSession.id))
      .then(async (revoked) => {
        if (!revoked || !loginSession.current) return
        await beginSessionSignOut()
        navigate('signed-out')
      })
  }

  const toggleSidebarVisibility = () => {
    const nextVisible = !sidebarVisible
    setSidebarVisible(nextVisible)
    toast.success(t(nextVisible ? 'shownToast' : 'hiddenToast'))
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('pageDescription')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleSidebarVisibility}
          >
            {sidebarVisible ? (
              <EyeOff data-icon="inline-start" />
            ) : (
              <Eye data-icon="inline-start" />
            )}
            {t(sidebarVisible ? 'hideFromSidebar' : 'showInSidebar')}
          </Button>
        </header>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!session || resource.loading || resource.busy}
            onClick={resource.reload}
          >
            <RefreshCw data-icon="inline-start" />
            {t('refresh')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!session}
            onClick={() => setDialogOpen(true)}
          >
            <QrCode data-icon="inline-start" />
            {t('addPhone')}
          </Button>
        </div>

        <Card aria-busy={resource.loading}>
          <CardHeader>
            <CardTitle>{t('sessionsTitle')}</CardTitle>
            <CardDescription>{t('sessionExplanation')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!session ? (
              <p className="text-sm text-muted-foreground">
                {t('accountUnavailable')}
              </p>
            ) : (
              <>
                {resource.loading && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t('loadingSessions')}
                  </p>
                )}
                {resource.error && (
                  <div
                    role="alert"
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm"
                  >
                    <div className="min-w-0 flex-1 text-destructive">
                      <p className="font-medium">{t('loadFailed')}</p>
                      <p className="break-words">{resource.error}</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={resource.loading}
                      onClick={resource.reload}
                    >
                      {t('retry')}
                    </Button>
                  </div>
                )}
                {mobileSessions.length > 0 && (
                  <ul className="divide-y divide-border">
                    {mobileSessions.map((loginSession) => (
                      <li
                        key={loginSession.id}
                        data-mobile-login-session={loginSession.id}
                        className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                      >
                        <div className="flex min-w-0 gap-3">
                          <Smartphone
                            aria-hidden="true"
                            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                          />
                          <div className="min-w-0 space-y-2">
                            <p className="break-words text-sm font-medium">
                              {loginSession.clientName}
                              {loginSession.current && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  {t('currentSession')}
                                </span>
                              )}
                            </p>
                            <dl className="space-y-1 text-xs text-muted-foreground">
                              {(
                                [
                                  ['createdAtLabel', loginSession.createdAt],
                                  ['lastSeenLabel', loginSession.lastSeenAt],
                                  ['sessionExpiresAt', loginSession.expiresAt],
                                ] as const
                              ).map(([label, value]) => (
                                <div
                                  key={label}
                                  className="flex flex-wrap gap-x-2"
                                >
                                  <dt>{t(label)}</dt>
                                  <dd>{dateLabel(value)}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={resource.busy || resource.loading}
                          onClick={() => revokeSession(loginSession)}
                        >
                          {t('revoke')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {!resource.loading &&
                  !resource.error &&
                  resource.data &&
                  mobileSessions.length === 0 && (
                    <div className="rounded-lg bg-muted/40 p-4 text-sm">
                      <p className="font-medium">{t('emptyTitle')}</p>
                      <p className="mt-2 text-muted-foreground">
                        {t('emptyDescription')}
                      </p>
                    </div>
                  )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <MobileConnectionDialog
        token={session?.accessToken ?? ''}
        userId={me ? accountDisplayName(me) : (session?.userId ?? '')}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  )
}
