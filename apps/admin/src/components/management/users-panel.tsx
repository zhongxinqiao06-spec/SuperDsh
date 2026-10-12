'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AdminUser } from '@/features/auth/types'
import { managementApi, type PlatformRole } from '@/features/management/api'
import {
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'
import { ManagementDialog, ManagementPagination } from './presentation'

type Draft = {
  username: string
  email: string
  displayName: string
  password: string
  roles: string[]
}
const newDraft = (): Draft => ({
  username: '',
  email: '',
  displayName: '',
  password: '',
  roles: ['member'],
})

export function UsersPanel() {
  const tr = useManagementText()
  const { can, me } = useAuth()
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [editing, setEditing] = React.useState<AdminUser | 'new' | null>(null)
  const [draft, setDraft] = React.useState<Draft>(newDraft)
  const [roles, setRoles] = React.useState<PlatformRole[]>([])
  const [confirmation, setConfirmation] = React.useState<{
    user: AdminUser
    action: 'delete' | 'disable' | 'activate' | 'restore' | 'reset'
  } | null>(null)
  const resource = useManagementResource(`${page}:${pageSize}:${search}`, () =>
    managementApi.users(page, search, pageSize),
  )
  const editable = can('users.manage')
  const canAssign = can('roles.manage')
  const total = resource.data?.total ?? resource.data?.users.length ?? 0
  React.useEffect(() => {
    if (resource.data && !resource.loading)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(total / pageSize))),
      )
  }, [resource.data, resource.loading, total, pageSize])
  React.useEffect(() => {
    if (!canAssign) return
    let active = true
    void managementApi
      .roles()
      .then((value) => {
        if (active) setRoles(value.roles)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [canAssign])
  const openEditor = (user: AdminUser | 'new') => {
    setEditing(user)
    setDraft(
      user === 'new'
        ? newDraft()
        : {
            username: user.username ?? '',
            email: user.email ?? '',
            displayName: user.displayName,
            password: '',
            roles: user.roles ?? [user.role],
          },
    )
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || resource.busy) return
    const ok = await resource.perform(() =>
      editing === 'new'
        ? managementApi.createUser({
            username: draft.username.trim(),
            ...(draft.email.trim() ? { email: draft.email.trim() } : {}),
            displayName: draft.displayName.trim(),
            password: draft.password,
            roles: draft.roles,
          })
        : managementApi.updateUser(editing.userId, {
            displayName: draft.displayName.trim(),
            ...(canAssign && editing.userId !== me?.userId
              ? { roles: draft.roles }
              : {}),
          }),
    )
    if (ok) {
      setEditing(null)
      setDraft(newDraft())
    }
  }
  const availableRoles = roles.length
    ? roles
    : [
        { id: 'admin', name: tr('管理员', 'Administrator') },
        { id: 'member', name: tr('普通成员', 'Member') },
      ]
  const actionLabel = (action: NonNullable<typeof confirmation>['action']) =>
    ({
      delete: tr('删除用户', 'Delete user'),
      disable: tr('禁用用户', 'Disable user'),
      activate: tr('激活用户', 'Activate user'),
      restore: tr('恢复用户', 'Restore user'),
      reset: tr('发起密码重置', 'Request password reset'),
    })[action]
  const confirmAction = async () => {
    if (!confirmation) return
    const { user, action } = confirmation
    const ok = await resource.perform(async () => {
      if (action === 'delete') await managementApi.deleteUser(user.userId)
      else if (action === 'restore')
        await managementApi.restoreUser(user.userId)
      else if (action === 'reset') {
        await managementApi.resetUser(user.userId)
        toast.info(
          tr(
            '请用户在登录页用自己的恢复码重置密码。管理员无法设置他人的新密码。',
            'The user must reset their password with their own recovery code on the sign-in page.',
          ),
        )
      } else
        await managementApi.updateUser(user.userId, {
          disabled: action === 'disable',
        })
    })
    if (ok) setConfirmation(null)
  }
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-2 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault()
          setPage(1)
          setSearch(query.trim())
        }}
      >
        <Input
          aria-label={tr('搜索用户', 'Search users')}
          placeholder={tr(
            '搜索用户名、邮箱或名称',
            'Username, email or display name',
          )}
          className="max-w-sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="outline" size="sm" type="submit">
          {tr('搜索', 'Search')}
        </Button>
        {editable && (
          <Button
            size="sm"
            type="button"
            disabled={resource.busy}
            onClick={() => openEditor('new')}
          >
            {tr('创建用户', 'Create user')}
          </Button>
        )}
      </form>
      <ResourceState {...resource} onRetry={resource.reload} />
      {editing && (
        <ManagementDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null)
              setDraft(newDraft())
            }
          }}
          title={
            editing === 'new'
              ? tr('创建用户', 'Create user')
              : tr('编辑用户与角色', 'Edit user and roles')
          }
          busy={resource.busy}
          error={resource.error}
        >
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <fieldset disabled={resource.busy} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldLabel title={tr('用户名', 'Username')}>
                  <Input
                    required
                    disabled={editing !== 'new'}
                    value={draft.username}
                    onChange={(event) =>
                      setDraft({ ...draft, username: event.target.value })
                    }
                    autoComplete="off"
                  />
                </FieldLabel>
                <FieldLabel title={tr('显示名称', 'Display name')}>
                  <Input
                    required
                    value={draft.displayName}
                    onChange={(event) =>
                      setDraft({ ...draft, displayName: event.target.value })
                    }
                  />
                </FieldLabel>
                {editing === 'new' && (
                  <>
                    <FieldLabel title={tr('邮箱（可选）', 'Email (optional)')}>
                      <Input
                        type="email"
                        value={draft.email}
                        onChange={(event) =>
                          setDraft({ ...draft, email: event.target.value })
                        }
                      />
                    </FieldLabel>
                    <FieldLabel title={tr('初始密码', 'Initial password')}>
                      <Input
                        type="password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                        value={draft.password}
                        onChange={(event) =>
                          setDraft({ ...draft, password: event.target.value })
                        }
                      />
                    </FieldLabel>
                  </>
                )}
              </div>
              <fieldset
                disabled={
                  !canAssign ||
                  (editing !== 'new' && editing.userId === me?.userId)
                }
                className="flex flex-wrap gap-4"
              >
                <legend className="mb-2 text-sm">
                  {tr('角色（权限取并集）', 'Roles (permissions are combined)')}
                </legend>
                {availableRoles.map((role) => (
                  <label
                    key={role.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={draft.roles.includes(role.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          roles: event.target.checked
                            ? [...draft.roles, role.id]
                            : draft.roles.filter((id) => id !== role.id),
                        })
                      }
                    />
                    {role.name}
                  </label>
                ))}
              </fieldset>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  size="sm"
                  disabled={resource.busy || draft.roles.length === 0}
                  type="submit"
                >
                  {tr('保存', 'Save')}
                </Button>
                <Button
                  size="sm"
                  disabled={resource.busy}
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setEditing(null)
                    setDraft(newDraft())
                  }}
                >
                  {tr('取消', 'Cancel')}
                </Button>
              </div>
            </fieldset>
          </form>
        </ManagementDialog>
      )}
      <ManagementDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={confirmation ? actionLabel(confirmation.action) : ''}
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={resource.busy}
              onClick={() => setConfirmation(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant={
                confirmation?.action === 'activate' ||
                confirmation?.action === 'restore'
                  ? 'default'
                  : 'destructive'
              }
              disabled={resource.busy}
              onClick={() => void confirmAction()}
            >
              {tr('确认', 'Confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {confirmation &&
            tr(
              `确认对用户「${confirmation.user.displayName}」执行${actionLabel(confirmation.action)}？`,
              `Confirm ${actionLabel(confirmation.action).toLowerCase()} for ${confirmation.user.displayName}?`,
            )}
        </p>
        {confirmation?.action === 'delete' && (
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              '账号将停用并撤销登录，数据保留，之后可以恢复。',
              'The account will be deactivated and its logins revoked. Data is retained and the account can be restored.',
            )}
          </p>
        )}
        {confirmation?.action === 'reset' && (
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              '会撤销该账号现有登录。用户需要使用本人恢复码完成密码重置。',
              'Existing logins will be revoked. The user must complete recovery with their own recovery code.',
            )}
          </p>
        )}
      </ManagementDialog>
      <div className="overflow-x-auto rounded-xl border">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('用户', 'User')}</th>
              <th>{tr('角色', 'Roles')}</th>
              <th>{tr('状态', 'Status')}</th>
              <th>{tr('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.users.map((user) => (
              <tr key={user.userId}>
                <td>
                  <div className="font-medium">{user.displayName}</div>
                  <div className="text-muted-foreground">
                    {user.username || user.email || user.userId}
                  </div>
                  {user.username && user.email && (
                    <div className="text-xs text-muted-foreground">
                      {user.email}
                    </div>
                  )}
                </td>
                <td>
                  {(user.roles ?? [user.role])
                    .map(
                      (id) => roles.find((role) => role.id === id)?.name ?? id,
                    )
                    .join(', ')}
                </td>
                <td>
                  {user.deletedAt
                    ? tr('已删除', 'Deleted')
                    : user.disabled
                      ? tr('已禁用', 'Disabled')
                      : tr('已激活', 'Active')}
                </td>
                <td>
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      {!user.deletedAt && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resource.busy}
                            onClick={() => openEditor(user)}
                          >
                            {tr('编辑', 'Edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              resource.busy || me?.userId === user.userId
                            }
                            onClick={() =>
                              setConfirmation({
                                user,
                                action: user.disabled ? 'activate' : 'disable',
                              })
                            }
                          >
                            {user.disabled
                              ? tr('激活', 'Activate')
                              : tr('禁用', 'Disable')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resource.busy}
                            onClick={() =>
                              setConfirmation({ user, action: 'reset' })
                            }
                          >
                            {tr('本人重置密码', 'Account recovery')}
                          </Button>
                        </>
                      )}
                      {user.deletedAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resource.busy}
                          onClick={() =>
                            setConfirmation({ user, action: 'restore' })
                          }
                        >
                          {tr('恢复用户', 'Restore user')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={resource.busy || me?.userId === user.userId}
                          onClick={() =>
                            setConfirmation({ user, action: 'delete' })
                          }
                        >
                          {tr('删除', 'Delete')}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.loading && !resource.data?.users.length && (
          <p className="p-6 text-sm text-muted-foreground">
            {tr('没有匹配的用户。', 'No matching users.')}
          </p>
        )}
      </div>
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
    </div>
  )
}
