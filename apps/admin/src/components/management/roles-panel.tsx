'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { managementApi, type PlatformRole } from '@/features/management/api'
import {
  FieldLabel,
  ResourceState,
  useManagementResource,
  useManagementText,
} from './controls'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
  useClientPagination,
} from './presentation'

export function RolesPanel() {
  const tr = useManagementText()
  const resource = useManagementResource('roles', managementApi.roles)
  const [editing, setEditing] = React.useState<PlatformRole | 'new' | null>(
    null,
  )
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [permissions, setPermissions] = React.useState<string[]>([])
  const [deleting, setDeleting] = React.useState<PlatformRole | null>(null)
  const [search, setSearch] = React.useState('')
  const filteredRoles = React.useMemo(
    () =>
      (resource.data?.roles ?? []).filter((role) =>
        `${role.name} ${role.description}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [resource.data, search],
  )
  const pagination = useClientPagination(filteredRoles, search)
  const open = (role: PlatformRole | 'new') => {
    setEditing(role)
    setName(role === 'new' ? '' : role.name)
    setDescription(role === 'new' ? '' : role.description)
    setPermissions(role === 'new' ? [] : role.permissions)
  }
  const locked = editing !== null && editing !== 'new' && editing.builtin
  return (
    <ManagementList
      pagination={
        <ManagementPagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
          loading={resource.loading || resource.busy}
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <p className="text-sm text-muted-foreground">
          {tr(
            '管理员和普通用户是内置角色，仅可查看；自定义角色可编辑权限。',
            'Administrator and member are built-in roles and can only be viewed. Custom role permissions can be edited.',
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            className="w-56"
            aria-label={tr('搜索角色', 'Search roles')}
            placeholder={tr('搜索角色', 'Search roles')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            size="sm"
            disabled={resource.busy}
            onClick={() => open('new')}
          >
            {tr('创建角色', 'Create role')}
          </Button>
        </div>
      </div>
      <ResourceState {...resource} onRetry={resource.reload} />
      <div className="grid gap-3 sm:grid-cols-2">
        {pagination.items.map((role) => (
          <div className="rounded-xl border p-4" key={role.id}>
            <div className="flex justify-between gap-3">
              <h2 className="font-semibold">{role.name}</h2>
              <span className="text-xs text-muted-foreground">
                {role.builtin ? tr('内置', 'Built-in') : tr('自定义', 'Custom')}
              </span>
            </div>
            <p className="my-2 text-sm text-muted-foreground">
              {role.description}
            </p>
            <p className="mb-4 text-sm">
              {role.permissions.length} {tr('项权限', 'permissions')}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={resource.busy}
                onClick={() => open(role)}
              >
                {role.builtin
                  ? tr('查看权限', 'View permissions')
                  : tr('编辑', 'Edit')}
              </Button>
              {!role.builtin && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={resource.busy}
                  onClick={() => setDeleting(role)}
                >
                  {tr('删除', 'Delete')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!resource.loading && pagination.total === 0 && (
        <p className="rounded-xl border p-6 text-sm text-muted-foreground">
          {tr('没有匹配的角色。', 'No matching roles.')}
        </p>
      )}

      {editing && (
        <ManagementDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          title={
            editing === 'new'
              ? tr('创建角色', 'Create role')
              : locked
                ? tr('查看角色权限', 'View role permissions')
                : tr('编辑角色', 'Edit role')
          }
          busy={resource.busy}
          error={resource.error}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (locked || resource.busy) return
              void resource
                .perform(() =>
                  managementApi.saveRole(
                    editing === 'new' ? null : editing.id,
                    {
                      name: name.trim(),
                      description: description.trim(),
                      permissions,
                    },
                  ),
                )
                .then((ok) => {
                  if (ok) setEditing(null)
                })
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldLabel title={tr('角色名称', 'Role name')}>
                <Input
                  required
                  value={name}
                  disabled={locked || resource.busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </FieldLabel>
              <FieldLabel title={tr('说明', 'Description')}>
                <Input
                  value={description}
                  disabled={locked || resource.busy}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </FieldLabel>
            </div>
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-3 font-medium">
                {tr('允许的操作', 'Allowed operations')}
              </legend>
              {resource.data?.permissions.map((permission) => (
                <label
                  className="flex items-start gap-2 text-sm"
                  key={permission.id}
                >
                  <input
                    className="mt-1"
                    type="checkbox"
                    disabled={locked || resource.busy}
                    checked={permissions.includes(permission.id)}
                    onChange={(event) =>
                      setPermissions(
                        event.target.checked
                          ? [...permissions, permission.id]
                          : permissions.filter((id) => id !== permission.id),
                      )
                    }
                  />
                  <span>
                    {permission.label}
                    <span className="block text-xs text-muted-foreground">
                      {permission.id}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex justify-end gap-2 border-t pt-4">
              {!locked && (
                <Button
                  size="sm"
                  disabled={resource.busy || !name.trim()}
                  type="submit"
                >
                  {tr('保存权限', 'Save permissions')}
                </Button>
              )}
              <Button
                size="sm"
                disabled={resource.busy}
                type="button"
                variant="outline"
                onClick={() => setEditing(null)}
              >
                {tr('关闭', 'Close')}
              </Button>
            </div>
          </form>
        </ManagementDialog>
      )}
      <ManagementDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={tr('删除角色', 'Delete role')}
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={resource.busy}
              onClick={() => setDeleting(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={resource.busy}
              onClick={() => {
                if (deleting)
                  void resource
                    .perform(() => managementApi.deleteRole(deleting.id))
                    .then((ok) => {
                      if (ok) setDeleting(null)
                    })
              }}
            >
              {tr('确认删除', 'Confirm delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {deleting &&
            tr(
              `确认删除角色「${deleting.name}」？请先解除所有用户对该角色的分配，删除后无法恢复。`,
              `Delete role ${deleting.name}? Remove all user assignments first. This cannot be undone.`,
            )}
        </p>
      </ManagementDialog>
    </ManagementList>
  )
}
