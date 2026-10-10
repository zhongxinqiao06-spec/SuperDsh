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
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [editing, setEditing] = React.useState<AdminUser | 'new' | null>(null)
  const [draft, setDraft] = React.useState<Draft>(newDraft)
  const [roles, setRoles] = React.useState<PlatformRole[]>([])
  const resource = useManagementResource(`${page}:${search}`, () =>
    managementApi.users(page, search),
  )
  const editable = can('users.manage')
  const canAssign = can('roles.manage')
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
    if (!editing) return
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
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
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
        <Button variant="outline" type="submit">
          {tr('搜索', 'Search')}
        </Button>
        {editable && (
          <Button type="button" onClick={() => openEditor('new')}>
            {tr('创建用户', 'Create user')}
          </Button>
        )}
      </form>
      <ResourceState {...resource} onRetry={resource.reload} />
      {editing && (
        <form
          onSubmit={(event) => void save(event)}
          className="space-y-4 rounded-xl border p-4"
        >
          <h2 className="font-semibold">
            {editing === 'new'
              ? tr('创建用户', 'Create user')
              : tr('编辑用户与角色', 'Edit user and roles')}
          </h2>
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
              !canAssign || (editing !== 'new' && editing.userId === me?.userId)
            }
            className="flex flex-wrap gap-4"
          >
            <legend className="mb-2 text-sm">
              {tr('角色（权限取并集）', 'Roles (permissions are combined)')}
            </legend>
            {availableRoles.map((role) => (
              <label key={role.id} className="flex items-center gap-2 text-sm">
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
          <div className="flex gap-2">
            <Button
              disabled={resource.busy || draft.roles.length === 0}
              type="submit"
            >
              {tr('保存', 'Save')}
            </Button>
            <Button
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
        </form>
      )}
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
                              void resource.perform(() =>
                                managementApi.updateUser(user.userId, {
                                  disabled: !user.disabled,
                                }),
                              )
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
                              void resource.perform(async () => {
                                await managementApi.resetUser(user.userId)
                                toast.info(
                                  tr(
                                    '请用户在登录页用自己的恢复码重置密码。管理员无法设置他人的新密码。',
                                    'The user must reset their password with their own recovery code on the sign-in page.',
                                  ),
                                )
                              })
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
                            void resource.perform(() =>
                              managementApi.restoreUser(user.userId),
                            )
                          }
                        >
                          {tr('恢复用户', 'Restore user')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={resource.busy || me?.userId === user.userId}
                          onClick={() => {
                            if (
                              window.confirm(
                                tr(
                                  `删除用户 ${user.displayName}？账号将停用，之后可以恢复。`,
                                  `Delete ${user.displayName}? The account will be deactivated and can be restored.`,
                                ),
                              )
                            )
                              void resource.perform(() =>
                                managementApi.deleteUser(user.userId),
                              )
                          }}
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
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>
          {tr('用户总数', 'Total users')}:{' '}
          {resource.data?.total ?? resource.data?.users.length ?? 0} ·{' '}
          {tr('页', 'Page')} {page}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={page === 1 || resource.loading}
            onClick={() => setPage(page - 1)}
          >
            {tr('上一页', 'Previous')}
          </Button>
          <Button
            variant="outline"
            disabled={
              resource.loading ||
              page * (resource.data?.pageSize ?? 25) >=
                (resource.data?.total ?? resource.data?.users.length ?? 0)
            }
            onClick={() => setPage(page + 1)}
          >
            {tr('下一页', 'Next')}
          </Button>
        </div>
      </div>
    </div>
  )
}
