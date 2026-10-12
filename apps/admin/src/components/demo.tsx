'use client'

import * as React from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from '@/components/ui/sidebar'
import { DashboardSidebarControlsContext } from '@/components/dashboard-sidebar-controls'
import { SessionToolSidebarStateProvider } from '@/components/session-tool-sidebar-state'
import { SessionToolSidebarsHost } from '@/components/session-tool-sidebar'
import { WorkspaceSidebarControl } from '@/components/workspace-sidebar-control'
import { AppSidebar } from '@/components/app-sidebar'
import { TaskComposer } from '@/components/task-composer'
import { SessionView } from '@/components/session-view'
import { useManagementText } from '@/components/management/controls'
import { ArchivedSessionsTab } from '@/components/settings/archived-sessions-tab'
import { WorkbenchAgentLifecycle } from '@/features/workbench/agent-lifecycle'
import { DevicePage } from '@/components/pages/device-page'
import { WorkspaceProvider, useWorkspace } from '@/components/workspace-context'
import { LoadingState } from '@/components/loading-state'
import { PairDeviceDialog } from '@/components/pair-device-dialog'
import { AgentSetupProvider } from '@/components/agent-setup-provider'
import { useAuth } from '@/components/auth/auth-context'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useTranslations } from 'next-intl'

const SIDEBAR_LAYOUT_STORAGE_KEY = 'agents-anywhere-dashboard-sidebar-layout'
const DEFAULT_DESKTOP_LAYOUT = {
  'dashboard-sidebar': 256,
  'dashboard-main': 1024,
}

const SIDEBAR_MOTION_DURATION_MS = 220
const DESKTOP_SIDEBAR_MIN_WIDTH = 224

export function Demo() {
  const { session } = useAuth()
  return (
    <WorkspaceProvider key={session?.userId ?? 'signed-out'}>
      <WorkbenchAgentLifecycle />
      <AgentSetupProvider>
        <SessionToolSidebarStateProvider key={session?.userId ?? 'signed-out'}>
          <SidebarProvider className="h-full min-h-0">
            <DashboardShell />
            <SessionToolSidebarsHost />
          </SidebarProvider>
        </SessionToolSidebarStateProvider>
      </AgentSetupProvider>
    </WorkspaceProvider>
  )
}

function DashboardShell() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-none bg-background">
          <WorkspaceSidebarControl>
            <WorkspaceMain />
          </WorkspaceSidebarControl>
        </SidebarInset>
      </>
    )
  }

  return <DesktopResizableShell />
}

function DesktopResizableShell() {
  const { open, setOpen } = useSidebar()
  const desktopShellRef = React.useRef<HTMLDivElement | null>(null)
  const sidebarPanelRef = React.useRef<PanelImperativeHandle | null>(null)
  const sidebarMotionActiveRef = React.useRef(false)
  const sidebarMotionTimerRef = React.useRef<number | null>(null)
  const [sidebarResizeActive, setSidebarResizeActive] = React.useState(false)
  const [defaultLayout] = React.useState(() => {
    if (typeof window === 'undefined') return DEFAULT_DESKTOP_LAYOUT

    const stored = window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY)
    if (!stored) return DEFAULT_DESKTOP_LAYOUT

    try {
      const layout = JSON.parse(stored) as Record<string, number>
      return typeof layout['dashboard-sidebar'] === 'number' &&
        typeof layout['dashboard-main'] === 'number'
        ? layout
        : DEFAULT_DESKTOP_LAYOUT
    } catch {
      return DEFAULT_DESKTOP_LAYOUT
    }
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(
    defaultLayout['dashboard-sidebar'] ??
      DEFAULT_DESKTOP_LAYOUT['dashboard-sidebar'],
  )

  const beginSidebarMotion = React.useCallback(() => {
    sidebarMotionActiveRef.current = true
    if (sidebarMotionTimerRef.current !== null) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    sidebarMotionTimerRef.current = window.setTimeout(() => {
      sidebarMotionActiveRef.current = false
      sidebarMotionTimerRef.current = null
      const panel = sidebarPanelRef.current
      if (panel && !panel.isCollapsed()) {
        setSidebarWidth(panel.getSize().inPixels)
      }
    }, SIDEBAR_MOTION_DURATION_MS + 40)
  }, [])

  React.useEffect(
    () => () => {
      if (sidebarMotionTimerRef.current !== null) {
        window.clearTimeout(sidebarMotionTimerRef.current)
      }
    },
    [],
  )

  React.useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return

    if (open && panel.isCollapsed()) {
      beginSidebarMotion()
      panel.expand()
      return
    }

    if (!open && !panel.isCollapsed()) {
      beginSidebarMotion()
      panel.collapse()
    }
  }, [beginSidebarMotion, open])

  const collapseSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (panel && !panel.isCollapsed()) {
      beginSidebarMotion()
      panel.collapse()
    }
    setOpen(false, { persist: false })
  }, [beginSidebarMotion, setOpen])

  const toggleSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (open) {
      if (panel && !panel.isCollapsed()) {
        beginSidebarMotion()
        panel.collapse()
      }
      setOpen(false, { persist: false })
      return
    }

    if (panel?.isCollapsed()) {
      beginSidebarMotion()
      panel.expand()
    }
    setOpen(true, { persist: false })
  }, [beginSidebarMotion, open, setOpen])

  const sidebarControls = React.useMemo(
    () => ({ open, collapseSidebar, toggleSidebar }),
    [open, collapseSidebar, toggleSidebar],
  )
  const panelMotionClassName = sidebarResizeActive
    ? '[&>[data-panel]]:transition-none'
    : '[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-[220ms] [&>[data-panel]]:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:[&>[data-panel]]:transition-none'

  return (
    <DashboardSidebarControlsContext.Provider value={sidebarControls}>
      <div
        ref={desktopShellRef}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background"
        style={
          {
            '--desktop-sidebar-width': `${Math.max(sidebarWidth, DESKTOP_SIDEBAR_MIN_WIDTH)}px`,
          } as React.CSSProperties
        }
      >
        <ResizablePanelGroup
          id="agents-anywhere-dashboard-sidebar"
          defaultLayout={defaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) {
              window.localStorage.setItem(
                SIDEBAR_LAYOUT_STORAGE_KEY,
                JSON.stringify(layout),
              )
            }
          }}
          direction="horizontal"
          className={`min-h-0 flex-1 overflow-hidden overscroll-none bg-background ${panelMotionClassName}`}
        >
          <ResizablePanel
            id="dashboard-sidebar"
            panelRef={sidebarPanelRef}
            collapsible
            collapsedSize={0}
            defaultSize="16rem"
            minSize="14rem"
            maxSize="28rem"
            onResize={(size) => {
              const isCollapsed =
                sidebarPanelRef.current?.isCollapsed() ?? size.inPixels <= 1
              if (!sidebarMotionActiveRef.current && !isCollapsed) {
                desktopShellRef.current?.style.setProperty(
                  '--desktop-sidebar-width',
                  `${Math.max(size.inPixels, DESKTOP_SIDEBAR_MIN_WIDTH)}px`,
                )
                setSidebarWidth(size.inPixels)
              }
              const nextOpen = !isCollapsed
              if (nextOpen !== open) {
                setOpen(nextOpen, { persist: false })
              }
            }}
            className="min-w-0"
            style={{ overflow: 'hidden' }}
          >
            <div
              className="h-full shrink-0 overflow-hidden"
              style={{
                width: Math.max(sidebarWidth, DESKTOP_SIDEBAR_MIN_WIDTH),
              }}
            >
              <AppSidebar contained />
            </div>
          </ResizablePanel>
          <ResizableHandle
            className="bg-transparent"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setSidebarResizeActive(true)
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              setSidebarResizeActive(false)
            }}
            onPointerCancel={() => setSidebarResizeActive(false)}
            onLostPointerCapture={() => setSidebarResizeActive(false)}
          />
          <ResizablePanel id="dashboard-main" minSize={0} className="min-w-0">
            <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-none bg-background">
              <WorkspaceSidebarControl>
                <WorkspaceMain />
              </WorkspaceSidebarControl>
            </SidebarInset>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </DashboardSidebarControlsContext.Provider>
  )
}

export function WorkspaceMain() {
  const { session, can } = useAuth()
  const tr = useManagementText()
  const {
    page,
    settingsTab,
    isLoading,
    routeReady,
    firstDevicePromptOpen,
    pairDeviceDialogOpen,
    closeFirstDevicePrompt,
    openPairDeviceDialog,
    closePairDeviceDialog,
    refreshData,
    projects,
    sessions,
    openSession,
    upsertSession,
  } = useWorkspace()
  const t = useTranslations('dashboard.firstDevice')
  const needsWorkspaceData = page === 'session' || page === 'device'
  if (!routeReady || (needsWorkspaceData && isLoading)) {
    return <LoadingState className="h-full bg-background" />
  }
  if (
    !['home', 'session', 'device', 'settings'].includes(page) ||
    (page === 'settings' && settingsTab !== 'archived-sessions')
  )
    return null
  const denied =
    (page === 'device' && !can('devices.read')) ||
    ((page === 'session' || page === 'settings') && !can('sessions.read'))
  const content = denied ? (
    <p role="alert" className="p-8 text-sm text-muted-foreground">
      {tr(
        '403 · 当前账号无权访问此工作台页面。',
        '403 · You do not have permission to access this workspace page.',
      )}
    </p>
  ) : page === 'session' ? (
    <SessionView />
  ) : page === 'device' ? (
    <DevicePage />
  ) : page === 'settings' ? (
    <div className="h-full overflow-auto p-6">
      <ArchivedSessionsTab
        token={session?.accessToken ?? ''}
        projects={projects}
        sessions={sessions}
        loading={isLoading}
        onOpenSession={openSession}
        onSessionUpdated={upsertSession}
        onWorkspaceRefresh={refreshData}
      />
    </div>
  ) : !can('sessions.run') ? (
    <p className="p-8 text-sm text-muted-foreground">
      {tr(
        '当前账号没有创建会话的权限。',
        'This account cannot create sessions.',
      )}
    </p>
  ) : (
    <TaskComposer />
  )
  return (
    <>
      {content}
      <AlertDialog
        open={firstDevicePromptOpen}
        onOpenChange={(open: boolean) => {
          if (!open) closeFirstDevicePrompt()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('later')}</AlertDialogCancel>
            <AlertDialogAction onClick={openPairDeviceDialog}>
              {t('addDevice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PairDeviceDialog
        open={pairDeviceDialogOpen}
        onOpenChange={(open) => {
          if (!open) closePairDeviceDialog()
        }}
        onConnectorCreated={() => {
          refreshData()
        }}
      />
    </>
  )
}
