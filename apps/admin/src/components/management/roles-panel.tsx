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

export function RolesPanel() {
  const tr = useManagementText()
  const resource = useManagementResource('roles', managementApi.roles)
  const [editing, setEditing] = React.useState<PlatformRole | 'new' | null>(
    null,
  )
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [permissions, setPermissions] = React.useState<string[]>([])
  const open = (role: PlatformRole | 'new') => {
    setEditing(role)
    setName(role === 'new' ? '' : role.name)
    setDescription(role === 'new' ? '' : role.description)
    setPermissions(role === 'new' ? [] : role.permissions)
  }
  const locked = editing !== null && editing !== 'new' && editing.id === 'admin'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {tr(
            '内置管理员拥有全部权限；普通成员和自定义角色的权限可编辑。',
            'The built-in administrator has every permission. Member and custom role permissions can be edited.',
          )}
        </p>
        <Button onClick={() => open('new')}>
          {tr('创建角色', 'Create role')}
        </Button>
      </div>
      <ResourceState {...resource} onRetry={resource.reload} />
      <div className="grid gap-3 sm:grid-cols-2">
        {resource.data?.roles.map((role) => (
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
              <Button variant="outline" size="sm" onClick={() => open(role)}>
                {role.id === 'admin'
                  ? tr('查看权限', 'View permissions')
                  : tr('编辑', 'Edit')}
              </Button>
              {!role.builtin && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={resource.busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        tr(
                          `删除角色 ${role.name}？`,
                          `Delete role ${role.name}?`,
                        ),
                      )
                    )
                      void resource.perform(() =>
                        managementApi.deleteRole(role.id),
                      )
                  }}
                >
                  {tr('删除', 'Delete')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <form
          className="space-y-4 rounded-xl border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void resource
              .perform(() =>
                managementApi.saveRole(editing === 'new' ? null : editing.id, {
                  name,
                  description,
                  permissions,
                }),
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
                disabled={locked}
                onChange={(event) => setName(event.target.value)}
              />
            </FieldLabel>
            <FieldLabel title={tr('说明', 'Description')}>
              <Input
                value={description}
                disabled={locked}
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
                  disabled={locked}
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
          <div className="flex gap-2">
            {!locked && (
              <Button disabled={resource.busy} type="submit">
                {tr('保存权限', 'Save permissions')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(null)}
            >
              {tr('关闭', 'Close')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
