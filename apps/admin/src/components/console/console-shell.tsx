'use client'

import * as React from 'react'
import { ChevronDown, LogOut, PanelLeft, RotateCw } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-context'
import { LoadingState } from '@/components/loading-state'
import {
  ResourceState,
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { accountDisplayName } from '@/features/auth/account-profile'
import { consoleApi, NAVIGATION_CHANGED_EVENT } from '@/features/console/api'
import { canOpenModule, consoleModules } from '@/features/console/modules'
import { visibleNavigation } from '@/features/console/navigation'
import type { MenuNode } from '@/features/console/types'
import { cn } from '@/lib/utils'
import { ConsoleIcon } from './console-icons'
import { useConsoleRoute } from './console-route'

export function ConsoleShell() {
  const { me, signOut, can } = useAuth()
  const tr = useManagementText()
  const route = useConsoleRoute()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const [expandedGroupId, setExpandedGroupId] = React.useState<string | null>(
    null,
  )
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const navigation = useManagementResource(
    `console-navigation:${me?.authzVersion ?? 0}`,
    consoleApi.navigation,
    { autoRefreshMs: 30_000 },
  )
  React.useEffect(() => {
    window.addEventListener(NAVIGATION_CHANGED_EVENT, navigation.reload)
    return () =>
      window.removeEventListener(NAVIGATION_CHANGED_EVENT, navigation.reload)
  }, [navigation.reload])
  const items = visibleNavigation(
    navigation.data?.items ?? [],
    me?.permissions ?? [],
    me?.roles ?? [],
  )
  const module = consoleModules.find((module) => module.id === route.moduleId)
  const activeItem = items.find((item) => item.moduleId === module?.id)
  const parent = items.find((item) => item.id === activeItem?.parentId)
  const title =
    activeItem?.title ??
    (module
      ? tr(module.title, module.englishTitle)
      : tr('页面不存在', 'Page not found'))
  const permitted = module && canOpenModule(module, me?.permissions)
  const standalone =
    module &&
    [
      'overview',
      'system.service',
      'account.profile',
      'account.security',
      'account.models',
      'account.appearance',
      'account.mobile',
      'access.menus',
    ].includes(module.id)
  const Page = module?.component
  const menusAllowed = can('menus.read') || can('menus.manage')
  const menu = (
    <>
      <div className="border-b border-sidebar-border px-5 py-5">
        <a
          href="#/overview"
          onClick={() => setMobileOpen(false)}
          className="text-lg font-semibold tracking-tight"
        >
          SuperDsh
        </a>
        <p className="mt-1 text-xs text-muted-foreground">
          {tr('统一管理平台', 'Management console')}
        </p>
      </div>
      <nav
        aria-label={tr('平台导航', 'Platform navigation')}
        className="no-scrollbar min-h-0 flex-1 space-y-1 overflow-x-hidden overflow-y-auto p-3"
      >
        <ResourceState
          loading={navigation.loading && !navigation.data}
          error={navigation.error}
          onRetry={navigation.reload}
        />
        {items
          .filter((item) => !item.parentId)
          .map((item) => (
            <NavigationItem
              key={item.id}
              item={item}
              items={items}
              active={module?.id}
              expandedGroupId={expandedGroupId}
              onToggleGroup={(id) =>
                setExpandedGroupId((current) => (current === id ? null : id))
              }
              onNavigate={() => setMobileOpen(false)}
            />
          ))}
        {!navigation.data && (
          <a
            className="block rounded-md p-3 text-sm hover:bg-sidebar-accent"
            href="#/overview"
            onClick={() => setMobileOpen(false)}
          >
            {tr('总览', 'Overview')}
          </a>
        )}
      </nav>
      <div className="space-y-2 border-t border-sidebar-border p-3">
        {menusAllowed && (
          <a
            className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-sidebar-accent"
            href="#/access/menus"
            onClick={() => setMobileOpen(false)}
          >
            <ConsoleIcon name="menu" />
            {tr('菜单管理与恢复', 'Manage / restore navigation')}
          </a>
        )}
        <div className="flex items-center gap-2">
          <a
            href="#/account/profile"
            onClick={() => setMobileOpen(false)}
            className="min-w-0 flex-1 rounded-md px-3 py-2 hover:bg-sidebar-accent"
          >
            <p className="truncate text-sm font-medium">
              {me ? accountDisplayName(me) : '—'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {me?.roles?.join(', ') || me?.role}
            </p>
          </a>
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr('退出登录', 'Sign out')}
            onClick={() => setSignOutOpen(true)}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </>
  )
  return (
    <div
      className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground"
      data-console-shell
    >
      <aside
        className={cn(
          'min-h-0 w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
          sidebarOpen ? 'hidden md:flex' : 'hidden',
        )}
      >
        {menu}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{tr('平台导航', 'Platform navigation')}</SheetTitle>
          </SheetHeader>
          {menu}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/40 px-4">
          <Button
            size="icon"
            variant="ghost"
            className="md:hidden"
            aria-label={tr('打开导航', 'Open navigation')}
            onClick={() => setMobileOpen(true)}
          >
            <PanelLeft className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="hidden md:inline-flex"
            aria-label={tr('切换导航', 'Toggle navigation')}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <PanelLeft className="size-4" />
          </Button>
          <nav
            aria-label={tr('面包屑', 'Breadcrumb')}
            className="flex min-w-0 items-center gap-2 text-sm"
          >
            <a
              href="#/overview"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              SuperDsh
            </a>
            <span className="text-muted-foreground">/</span>
            {parent && (
              <>
                <span className="truncate text-muted-foreground">
                  {parent.title}
                </span>
                <span className="text-muted-foreground">/</span>
              </>
            )}
            <span aria-current="page" className="truncate font-medium">
              {title}
            </span>
          </nav>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden" data-console-content>
          {!route.ready ? (
            <LoadingState className="h-full" />
          ) : !module ? (
            <RouteMessage
              code="404"
              text={tr(
                '没有找到这个页面，请从左侧菜单选择功能。',
                'This page does not exist. Choose a module from the navigation.',
              )}
            />
          ) : !permitted ? (
            <RouteMessage
              code="403"
              text={tr(
                '当前账号没有访问此功能的权限。',
                'Your account cannot access this feature.',
              )}
            />
          ) : (
            Page && (
              <ConsolePageBoundary
                key={`${me?.userId}:${module.id}:${me?.authzVersion ?? 0}`}
              >
                <React.Suspense fallback={<LoadingState className="h-full" />}>
                  {module.id === 'workbench' ? (
                    <Page />
                  ) : (
                    <div className="h-full overflow-y-auto">
                      <div
                        className={cn(
                          'mx-auto w-full max-w-6xl',
                          !standalone && 'space-y-6 p-4 sm:p-8',
                        )}
                      >
                        {!standalone && (
                          <h1 className="text-2xl font-semibold">{title}</h1>
                        )}
                        <Page />
                      </div>
                    </div>
                  )}
                </React.Suspense>
              </ConsolePageBoundary>
            )
          )}
        </div>
      </div>
      <Dialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr('退出登录', 'Sign out')}</DialogTitle>
            <DialogDescription>
              {tr(
                '退出当前网页账号，已提交的服务端任务继续运行。',
                'Sign out of this browser. Submitted server tasks continue running.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignOutOpen(false)}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button onClick={signOut}>{tr('退出登录', 'Sign out')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NavigationItem({
  item,
  items,
  active,
  expandedGroupId,
  onToggleGroup,
  onNavigate,
}: {
  item: MenuNode
  items: MenuNode[]
  active?: string
  expandedGroupId: string | null
  onToggleGroup: (id: string) => void
  onNavigate: () => void
}) {
  const open = expandedGroupId === item.id
  const module = consoleModules.find((module) => module.id === item.moduleId)
  if (item.kind === 'group')
    return (
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-sidebar-accent"
          aria-expanded={open}
          onClick={() => onToggleGroup(item.id)}
        >
          <ConsoleIcon name={item.icon} />
          <span className="flex-1 text-left">{item.title}</span>
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform',
              !open && '-rotate-90',
            )}
          />
        </button>
        {open && (
          <div className="ml-5 space-y-1 border-l border-sidebar-border pl-2">
            {items
              .filter((child) => child.parentId === item.id)
              .map((child) => (
                <NavigationItem
                  key={child.id}
                  item={child}
                  items={items}
                  active={active}
                  expandedGroupId={expandedGroupId}
                  onToggleGroup={onToggleGroup}
                  onNavigate={onNavigate}
                />
              ))}
          </div>
        )}
      </div>
    )
  if (!module) return null
  return (
    <a
      href={module.route}
      onClick={onNavigate}
      aria-current={active === module.id ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sidebar-accent',
        active === module.id
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/80',
      )}
    >
      <ConsoleIcon name={item.icon} />
      <span>{item.title}</span>
    </a>
  )
}

function RouteMessage({ code, text }: { code: string; text: string }) {
  const tr = useManagementText()
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      role="alert"
    >
      <h1 className="text-4xl font-semibold">{code}</h1>
      <p className="text-muted-foreground">{text}</p>
      <Button asChild variant="outline">
        <a href="#/overview">{tr('返回总览', 'Back to overview')}</a>
      </Button>
    </div>
  )
}

class ConsolePageBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    return this.state.error ? <PageFailure /> : this.props.children
  }
}

function PageFailure() {
  const tr = useManagementText()
  return (
    <div className="m-6 rounded-lg border p-6" role="alert">
      <h1 className="mb-3 text-lg font-medium">
        {tr('页面加载失败', 'Page failed to load')}
      </h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {tr(
          '可以切换其他模块，或刷新页面重试。',
          'You can open another module or reload to retry.',
        )}
      </p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        <RotateCw className="size-4" />
        {tr('刷新页面', 'Reload page')}
      </Button>
    </div>
  )
}
