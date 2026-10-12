'use client'

import { Bot, KeyRound, ShieldCheck, UserRound } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-context'
import { useManagementText } from '@/components/management/controls'
import { DashboardPage } from '@/components/pages/dashboard-page'
import { PageHeader } from '@/components/pages/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { accountDisplayName } from '@/features/auth/account-profile'

export function OverviewPage() {
  const { me, can } = useAuth()
  const tr = useManagementText()
  if (can('settings.manage')) return <DashboardPage />
  const links = [
    {
      title: tr('Agent 工作台', 'Agent workspace'),
      href: '#/workspace',
      icon: Bot,
      permissions: ['sessions.read', 'sessions.run', 'devices.read'],
    },
    {
      title: tr('个人资料', 'My profile'),
      href: '#/account/profile',
      icon: UserRound,
    },
    {
      title: tr('账号安全', 'Account security'),
      href: '#/account/security',
      icon: ShieldCheck,
    },
    {
      title: tr('个人模型', 'Personal models'),
      href: '#/account/models',
      icon: KeyRound,
      permissions: ['models.personal.manage'],
    },
  ].filter((link) => !link.permissions || link.permissions.some(can))
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
        <PageHeader
          title={tr('总览', 'Overview')}
          description={tr(
            '管理你的账号、模型与 Agent 工作。',
            'Manage your account, models and Agent work.',
          )}
        />
        <Card>
          <CardHeader>
            <CardTitle>
              {tr('欢迎回来', 'Welcome back')}，
              {me ? accountDisplayName(me) : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">
                  {tr('用户名', 'Username')}
                </dt>
                <dd className="mt-1">{me?.username || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tr('角色', 'Roles')}</dt>
                <dd className="mt-1">
                  {(me?.roles ?? [me?.role]).filter(Boolean).join(', ')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {tr('账号状态', 'Account status')}
                </dt>
                <dd className="mt-1">{tr('正常', 'Active')}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <section
          aria-label={tr('快捷入口', 'Quick links')}
          className="grid gap-4 sm:grid-cols-2"
        >
          {links.map(({ title, href, icon: Icon }) => (
            <Button
              key={href}
              asChild
              variant="outline"
              className="h-auto justify-start gap-3 rounded-xl p-5 text-base"
            >
              <a href={href}>
                <Icon className="size-5" />
                {title}
              </a>
            </Button>
          ))}
        </section>
      </div>
    </div>
  )
}
