'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { PageHeader } from './page-header'
import { Button } from '@/components/ui/button'
import { UsersPanel } from '@/components/management/users-panel'
import { RolesPanel } from '@/components/management/roles-panel'
import { DevicesPanel } from '@/components/management/devices-panel'
import { AuditPanel } from '@/components/management/audit-panel'
import { ModelsPanel } from '@/components/management/models-panel'
import { useManagementText } from '@/components/management/controls'

export function ManagementPage({
  initialTab = 'users',
  onBack,
  onTabChange,
}: {
  initialTab?: string
  onBack?: () => void
  onTabChange?: (tab: string) => void
}) {
  const tr = useManagementText()
  const { can, me } = useAuth()
  const [selected, setSelected] = React.useState(initialTab)
  React.useEffect(() => setSelected(initialTab), [initialTab])
  const tabs = [
    { id: 'users', permission: 'users.read', title: tr('用户', 'Users') },
    {
      id: 'roles',
      permission: 'roles.manage',
      title: tr('角色与权限', 'Roles and permissions'),
    },
    {
      id: 'devices',
      permission: 'devices.inventory.read',
      title: tr('设备运维', 'Device operations'),
    },
    {
      id: 'models',
      permission: 'models.manage',
      title: tr('平台模型', 'Platform models'),
    },
    {
      id: 'audit',
      permission: 'audit.read',
      title: tr('审计日志', 'Audit log'),
    },
  ].filter((tab) => can(tab.permission))
  const active = tabs.find((tab) => tab.id === selected)?.id ?? tabs[0]?.id
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
        <PageHeader
          title={tr('平台管理', 'Platform management')}
          description={tr(
            '管理账号、访问权限和平台服务。个人工作台中的内容仍按所属用户隔离。',
            'Manage accounts, permissions and platform services. Personal workspace content remains isolated by owner.',
          )}
          onBack={onBack}
        />
        <nav
          aria-label={tr('管理分类', 'Management sections')}
          className="flex flex-wrap gap-2 border-b pb-4"
        >
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant={active === tab.id ? 'default' : 'outline'}
              aria-current={active === tab.id ? 'page' : undefined}
              onClick={() => {
                setSelected(tab.id)
                onTabChange?.(tab.id)
              }}
            >
              {tab.title}
            </Button>
          ))}
        </nav>
        <div key={`${active}:${me?.authzVersion ?? 0}`}>
          {active === 'users' ? (
            <UsersPanel />
          ) : active === 'roles' ? (
            <RolesPanel />
          ) : active === 'devices' ? (
            <DevicesPanel />
          ) : active === 'models' ? (
            <ModelsPanel />
          ) : active === 'audit' ? (
            <AuditPanel />
          ) : (
            <p role="status">
              {tr(
                '当前账号没有平台管理权限。',
                'This account has no platform management permissions.',
              )}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
