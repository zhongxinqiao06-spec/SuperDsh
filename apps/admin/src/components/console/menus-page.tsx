'use client'

import * as React from 'react'
import { Folder, Plus, RotateCcw } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-context'
import {
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
  useClientPagination,
} from '@/components/management/presentation'
import { PageHeader } from '@/components/pages/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { consoleApi } from '@/features/console/api'
import type { MenuNode, MenusResponse } from '@/features/console/types'
import { ApiError } from '@/lib/api'
import { createClientId } from '@/lib/id'

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50'

export function MenusPage() {
  const tr = useManagementText()
  const { can, session } = useAuth()
  const allowed = can('menus.read') || can('menus.manage')
  const resource = useManagementResource('console-menus', consoleApi.menus, {
    enabled: allowed,
  })
  const [conflict, setConflict] = React.useState(false)
  const [editorRevision, setEditorRevision] = React.useState(0)
  const reload = () => {
    setConflict(false)
    setEditorRevision((value) => value + 1)
    resource.reload()
  }
  const update = (operation: () => Promise<MenusResponse>) =>
    resource.perform(async () => {
      try {
        await operation()
        setConflict(false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true)
          throw new Error(
            tr(
              '菜单已被其他管理员修改。请重新加载最新配置后再编辑；当前草稿不会覆盖其他人的更改。',
              'Another administrator changed the menu. Reload the latest configuration before editing; your draft will not overwrite their changes.',
            ),
            { cause: error },
          )
        }
        throw error
      }
    })
  if (!allowed)
    return (
      <p role="alert">
        {tr('没有菜单管理权限。', 'Menu access is not permitted.')}
      </p>
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-8">
        <PageHeader
          title={tr('菜单管理', 'Menu management')}
          description={tr(
            '配置导航名称、分组和角色显示范围。页面功能和访问权限由系统注册，隐藏菜单不会撤销权限。',
            'Configure navigation labels, groups and role visibility. Pages and permissions are registered by the system; hiding a menu does not revoke access.',
          )}
        />
        <ResourceState {...resource} onRetry={reload} />
        {conflict && (
          <Button variant="outline" onClick={reload}>
            {tr('重新加载最新配置', 'Reload latest configuration')}
          </Button>
        )}
        {resource.data && (
          <MenusEditor
            key={`${session?.userId}:${resource.data.version}:${editorRevision}`}
            data={resource.data}
            can={can}
            busy={resource.busy || resource.loading || conflict}
            error={resource.error}
            conflict={conflict}
            onSave={(items) =>
              update(() => consoleApi.saveMenus(resource.data!.version, items))
            }
            onReset={() =>
              update(() => consoleApi.resetMenus(resource.data!.version))
            }
            onReload={reload}
          />
        )}
      </div>
    </div>
  )
}

export function MenusEditor({
  data,
  can,
  busy,
  error,
  conflict,
  onSave,
  onReset,
  onReload,
}: {
  data: MenusResponse
  can: (permission: string) => boolean
  busy: boolean
  error: string
  conflict: boolean
  onSave: (items: MenuNode[]) => Promise<boolean>
  onReset: () => Promise<boolean>
  onReload: () => void
}) {
  const tr = useManagementText()
  const [selected, setSelected] = React.useState<MenuNode | null>(null)
  const [search, setSearch] = React.useState('')
  const [confirmation, setConfirmation] = React.useState<
    MenuNode | 'reset' | null
  >(null)
  const items = data.items
  const writable = can('menus.manage')
  const modules = new Map(data.modules.map((module) => [module.id, module]))
  const groups = items.filter((item) => item.kind === 'group')
  const canEditPage = (item: MenuNode) => {
    const module = modules.get(item.moduleId ?? '')
    return Boolean(
      module && (!module.permissions.length || module.permissions.some(can)),
    )
  }
  const canEdit = (item: MenuNode) =>
    writable &&
    (item.kind === 'page'
      ? canEditPage(item)
      : items.filter((child) => child.parentId === item.id).every(canEditPage))
  const locked = !selected || !canEdit(selected) || busy
  const roleOptions = [
    ...data.roles,
    ...(selected?.roleIds ?? [])
      .filter((id) => !data.roles.some((role) => role.id === id))
      .map((id) => ({
        id,
        name: tr('已删除角色 (' + id + ')', 'Deleted role (' + id + ')'),
      })),
  ]
  const sorted = [...items].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  )
  const rows = sorted
    .filter((item) => !item.parentId)
    .flatMap((item) => [
      item,
      ...sorted.filter((child) => child.parentId === item.id),
    ])
    .filter((item) =>
      (item.title + ' ' + (item.moduleId ?? ''))
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    )
  const pagination = useClientPagination(rows, search)
  const change = (patch: Partial<MenuNode>) => {
    if (!locked) setSelected((current) => current && { ...current, ...patch })
  }
  const addGroup = () => {
    if (!writable || busy) return
    setSelected({
      id: createClientId('group'),
      kind: 'group',
      moduleId: null,
      parentId: null,
      title: '',
      icon: 'folder',
      order: Math.min(
        10000,
        Math.max(0, ...items.map((item) => item.order)) + 10,
      ),
      visible: true,
      roleIds: [],
    })
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected || locked || !selected.title.trim()) return
    const updated = { ...selected, title: selected.title.trim() }
    const next = items.some((item) => item.id === updated.id)
      ? items.map((item) => (item.id === updated.id ? updated : item))
      : [...items, updated]
    if (await onSave(next)) setSelected(null)
  }
  const confirm = async () => {
    if (!confirmation || busy || !writable) return
    if (confirmation === 'reset') {
      if (await onReset()) setConfirmation(null)
      return
    }
    if (!canEdit(confirmation)) return
    const next = items
      .filter((item) => item.id !== confirmation.id)
      .map((item) =>
        item.parentId === confirmation.id ? { ...item, parentId: null } : item,
      )
    if (await onSave(next)) setConfirmation(null)
  }
  return (
    <ManagementList
      pagination={
        <ManagementPagination
          {...pagination}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
          loading={busy}
        />
      }
    >
      <div className="flex flex-wrap items-center gap-2 rounded-xl border p-4">
        <Input
          className="max-w-sm"
          aria-label={tr('搜索菜单', 'Search menus')}
          placeholder={tr('搜索菜单名称或功能标识', 'Search names or modules')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>
          {tr('刷新', 'Refresh')}
        </Button>
        <Button size="sm" disabled={!writable || busy} onClick={addGroup}>
          <Plus />
          {tr('新增分组', 'Add group')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!writable || busy}
          onClick={() => setConfirmation('reset')}
        >
          <RotateCcw />
          {tr('恢复默认', 'Restore defaults')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {tr('配置版本', 'Version')} {data.version}
        </span>
      </div>
      {!writable && (
        <p className="text-sm text-muted-foreground">
          {tr(
            '当前账号只有查看权限。',
            'This account has read-only menu access.',
          )}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('名称', 'Name')}</th>
              <th>{tr('类型 / 分组', 'Type / group')}</th>
              <th>{tr('显示状态', 'Visibility')}</th>
              <th>{tr('角色范围', 'Roles')}</th>
              <th>{tr('排序', 'Order')}</th>
              <th>{tr('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left font-medium hover:underline"
                    onClick={() => setSelected(structuredClone(item))}
                  >
                    {item.kind === 'group' && <Folder className="size-4" />}
                    {item.title}
                  </button>
                </td>
                <td>
                  {item.kind === 'group'
                    ? tr('分组', 'Group')
                    : (groups.find((group) => group.id === item.parentId)
                        ?.title ?? tr('一级页面', 'Top-level page'))}
                </td>
                <td>
                  {item.visible ? tr('显示', 'Visible') : tr('隐藏', 'Hidden')}
                </td>
                <td className="max-w-xs">
                  {item.roleIds.length
                    ? item.roleIds
                        .map(
                          (id) =>
                            data.roles.find((role) => role.id === id)?.name ??
                            id,
                        )
                        .join(', ')
                    : tr('按功能权限', 'By permissions')}
                </td>
                <td>{item.order}</td>
                <td>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setSelected(structuredClone(item))}
                    >
                      {canEdit(item) ? tr('编辑', 'Edit') : tr('查看', 'View')}
                    </Button>
                    {item.kind === 'group' && canEdit(item) && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => setConfirmation(item)}
                      >
                        {tr('删除', 'Delete')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-6 text-sm text-muted-foreground">
            {tr('没有匹配的菜单。', 'No matching menus.')}
          </p>
        )}
      </div>

      <ManagementDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={
          selected?.kind === 'group'
            ? tr('分组配置', 'Group configuration')
            : tr('页面配置', 'Page configuration')
        }
        description={tr(
          '保存后立即更新导航，取消不会修改当前配置。',
          'Saving updates navigation immediately. Cancel leaves the configuration unchanged.',
        )}
        busy={busy && !conflict}
        error={error}
        footer={
          <>
            {conflict && (
              <Button variant="outline" onClick={onReload}>
                {tr('重新加载最新配置', 'Reload latest configuration')}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy && !conflict}
              onClick={() => setSelected(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              type="submit"
              form="console-menu-editor"
              disabled={locked || !selected?.title.trim()}
            >
              {tr('保存菜单', 'Save menu')}
            </Button>
          </>
        }
      >
        {selected && (
          <form id="console-menu-editor" onSubmit={(event) => void save(event)}>
            <fieldset disabled={locked} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldLabel title={tr('名称', 'Name')}>
                  <Input
                    required
                    maxLength={64}
                    value={selected.title}
                    onChange={(event) => change({ title: event.target.value })}
                  />
                </FieldLabel>
                <FieldLabel title={tr('图标', 'Icon')}>
                  <select
                    className={selectClass}
                    value={selected.icon}
                    onChange={(event) => change({ icon: event.target.value })}
                  >
                    {data.icons.map((icon) => (
                      <option key={icon} value={icon}>
                        {icon}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                {selected.kind === 'page' && (
                  <FieldLabel title={tr('所属分组', 'Parent group')}>
                    <select
                      className={selectClass}
                      value={selected.parentId ?? ''}
                      onChange={(event) =>
                        change({ parentId: event.target.value || null })
                      }
                    >
                      <option value="">
                        {tr('一级菜单', 'Top-level menu')}
                      </option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.title}
                        </option>
                      ))}
                    </select>
                  </FieldLabel>
                )}
                <FieldLabel title={tr('排序', 'Order')}>
                  <Input
                    type="number"
                    step={1}
                    required
                    min={0}
                    max={10000}
                    value={selected.order}
                    onChange={(event) => {
                      const order = event.target.valueAsNumber
                      if (Number.isFinite(order)) change({ order })
                    }}
                  />
                </FieldLabel>
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{tr('在导航中显示', 'Show in navigation')}</span>
                <Switch
                  checked={selected.visible}
                  onCheckedChange={(visible) => change({ visible })}
                />
              </label>
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  {tr('角色显示范围', 'Visible to roles')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tr(
                    '不选角色表示按功能权限显示；选定角色后进一步收窄范围，不会增加任何访问权限。',
                    'No selection uses page permissions. Selecting roles narrows visibility and never grants access.',
                  )}
                </p>
                <div className="flex flex-wrap gap-4">
                  {roleOptions.map((role) => (
                    <label
                      key={role.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selected.roleIds.includes(role.id)}
                        onChange={(event) =>
                          change({
                            roleIds: event.target.checked
                              ? [...selected.roleIds, role.id]
                              : selected.roleIds.filter((id) => id !== role.id),
                          })
                        }
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              </div>

              {selected.kind === 'page' && (
                <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                  <p>
                    {tr('功能标识', 'Module')}: <code>{selected.moduleId}</code>
                  </p>
                  <p>
                    {tr('固定路由', 'Registered route')}:{' '}
                    <code>{modules.get(selected.moduleId ?? '')?.route}</code>
                  </p>
                  <p>
                    {tr('功能权限', 'Permissions')}:{' '}
                    {modules
                      .get(selected.moduleId ?? '')
                      ?.permissions.join(', ') ||
                      tr('所有登录用户', 'All signed-in users')}
                  </p>
                  <p>
                    {tr(
                      '内置页面不可删除或修改路由。',
                      'Registered pages cannot be removed or assigned a different route.',
                    )}
                  </p>
                </div>
              )}
              {!canEdit(selected) && writable && (
                <p className="text-sm text-muted-foreground">
                  {tr(
                    '此页面或分组包含当前账号无权管理的功能。',
                    'This page or group contains features outside your permissions.',
                  )}
                </p>
              )}
            </fieldset>
          </form>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => !open && setConfirmation(null)}
        title={
          confirmation === 'reset'
            ? tr('恢复默认菜单', 'Restore default menus')
            : tr('删除分组', 'Delete group')
        }
        description={
          confirmation === 'reset'
            ? tr(
                '当前菜单配置将被系统默认配置替换。页面功能和权限保持不变。',
                'Replace the current navigation with defaults. Features and permissions remain unchanged.',
              )
            : tr(
                '其中的页面会移到一级菜单，不会删除页面功能。',
                'Pages in this group will move to the top level. No feature will be removed.',
              )
        }
        busy={busy && !conflict}
        error={error}
        footer={
          <>
            {conflict && (
              <Button variant="outline" onClick={onReload}>
                {tr('重新加载最新配置', 'Reload latest configuration')}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy && !conflict}
              onClick={() => setConfirmation(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !writable}
              onClick={() => void confirm()}
            >
              {tr('确认', 'Confirm')}
            </Button>
          </>
        }
      />
    </ManagementList>
  )
}
