'use client'

import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/components/auth/auth-context'
import { PairDeviceDialog } from '@/components/pair-device-dialog'
import { DevicesSection } from '@/components/sidebar/devices-section'
import { ProjectConfirmationDialogs } from '@/components/sidebar/project-confirmation-dialogs'
import {
  ProjectEditorDialog,
  type ProjectEditorState,
} from '@/components/sidebar/project-editor-dialog'
import {
  ProjectsSection,
  type ProjectListController,
} from '@/components/sidebar/projects-section'
import { PinnedSection } from '@/components/sidebar/pinned-section'
import { RecentSessionsSection } from '@/components/sidebar/recent-sessions-section'
import {
  selectPinnedProjects,
  selectPinnedSessions,
  selectAllSessions,
  groupSessionsByProject,
  selectProjectSessions,
  selectRegularProjects,
  type ProjectSessionStatusFilter,
} from '@/components/sidebar/sidebar-selectors'
import { useProjectSidebarPreferences } from '@/components/sidebar/use-project-sidebar-preferences'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useWorkspace } from '@/components/workspace-context'
import { dashboardApi } from '@/features/dashboard/api'
import type { ProjectView } from '@/features/dashboard/types'
import { useTranslations } from 'next-intl'
import { useManagementText } from '@/components/management/controls'

export function AppSidebar({ contained = false }: { contained?: boolean }) {
  const {
    connectors,
    sessions,
    projects,
    isLoading,
    activeSessionId,
    activeConnectorId,
    page,
    filter,
    search,
    openSession,
    goHome,
    navigateToDevice,
    startProjectSession,
    sidebarShowsSessions,
    createProject,
    updateProject,
    archiveProjectSessions,
    togglePinSession,
    toggleArchiveSession,
    renameSession,
    refreshData,
  } = useWorkspace()
  const { session: authSession, can } = useAuth()
  const allowed = (permission: string) => !authSession || can(permission)
  const t = useTranslations('dashboard')
  const tr = useManagementText()
  const [pairOpen, setPairOpen] = React.useState(false)
  const {
    preferences: { projectsExpanded, expandedProjectIds },
    setProjectExpanded,
    setProjectsExpanded,
  } = useProjectSidebarPreferences(authSession?.userId ?? 'signed-out')
  const [projectEditor, setProjectEditor] =
    React.useState<ProjectEditorState>(null)
  const [projectToArchive, setProjectToArchive] =
    React.useState<ProjectView | null>(null)
  const [projectSessionStatus, setProjectSessionStatus] =
    React.useState<ProjectSessionStatusFilter>('active')

  const pinnedProjects = React.useMemo(
    () => selectPinnedProjects(projects, sessions, projectSessionStatus),
    [projectSessionStatus, projects, sessions],
  )
  const pinnedSessions = React.useMemo(
    () => selectPinnedSessions(sessions),
    [sessions],
  )
  const serverConnectorIds = React.useMemo(
    () =>
      new Set(
        connectors
          .filter((connector) => connector.executorKind === 'server-agent')
          .map((connector) => connector.id),
      ),
    [connectors],
  )
  const regularProjects = React.useMemo(
    () =>
      selectRegularProjects(projects, sessions, projectSessionStatus).filter(
        (project) => !serverConnectorIds.has(project.connectorId),
      ),
    [projectSessionStatus, projects, sessions, serverConnectorIds],
  )
  const allSessions = React.useMemo(
    () => selectAllSessions(sessions, filter, search),
    [filter, search, sessions],
  )
  const projectSessionsById = React.useMemo(
    () => groupSessionsByProject(sessions),
    [sessions],
  )
  const unassignedSessions = React.useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id))
    return allSessions.filter(
      (session) =>
        session.executorKind !== 'server-agent' &&
        !serverConnectorIds.has(session.connectorId) &&
        (!session.projectId || !projectIds.has(session.projectId)),
    )
  }, [allSessions, projects, serverConnectorIds])
  const serverSessions = allSessions.filter(
    (value) =>
      value.executorKind === 'server-agent' ||
      connectors.some(
        (connector) =>
          connector.id === value.connectorId &&
          connector.executorKind === 'server-agent',
      ),
  )

  const sessionsForProject = React.useCallback(
    (projectId: string, status: ProjectSessionStatusFilter = 'active') =>
      selectProjectSessions(projectSessionsById[projectId] ?? [], status),
    [projectSessionsById],
  )

  const markAllRead = React.useCallback(async () => {
    if (!authSession?.accessToken) return
    const unreadIds = sessions
      .filter((session) => session.unread)
      .map((session) => session.id)
    if (unreadIds.length === 0) return
    await dashboardApi.bulkMarkSessionsRead(authSession.accessToken, unreadIds)
    refreshData()
  }, [authSession?.accessToken, refreshData, sessions])

  const toggleProjectPin = React.useCallback(
    async (project: ProjectView) => {
      const updated = await updateProject(project.id, {
        pinned: !project.pinned,
      })
      if (!updated) toast.error(t('projects.updateFailed'))
    },
    [t, updateProject],
  )

  const showSessionUnarchivedToast = React.useCallback(
    (sessionId: string) => {
      toast.success(t('actions.unarchiveSuccess'), {
        action: {
          label: t('actions.viewNow'),
          onClick: () => openSession(sessionId),
        },
      })
    },
    [openSession, t],
  )

  const restoreArchivedSession = React.useCallback(
    async (sessionId: string) => {
      try {
        const updated = await toggleArchiveSession(sessionId, false)
        if (updated && !updated.archived) showSessionUnarchivedToast(sessionId)
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('actions.archiveUpdateFailed'),
        )
      }
    },
    [showSessionUnarchivedToast, t, toggleArchiveSession],
  )

  const handleToggleSessionArchive = React.useCallback(
    async (sessionId: string) => {
      try {
        const updated = await toggleArchiveSession(sessionId)
        if (!updated) return
        if (!updated.archived) {
          showSessionUnarchivedToast(sessionId)
          return
        }
        toast.success(t('actions.archiveSuccess'), {
          action: {
            label: t('actions.unarchive'),
            onClick: () => void restoreArchivedSession(sessionId),
          },
        })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('actions.archiveUpdateFailed'),
        )
      }
    },
    [
      restoreArchivedSession,
      showSessionUnarchivedToast,
      t,
      toggleArchiveSession,
    ],
  )

  const requestToggleSessionArchive = React.useCallback(
    (sessionId: string) => {
      void handleToggleSessionArchive(sessionId)
    },
    [handleToggleSessionArchive],
  )

  const projectController: ProjectListController = {
    sessionsForProject,
    expandedProjectIds,
    activeSessionId,
    onExpandedChange: setProjectExpanded,
    onOpenSession: openSession,
    onNewSession: startProjectSession,
    onEdit: (project) => setProjectEditor({ mode: 'edit', project }),
    onTogglePin: (project) => void toggleProjectPin(project),
    onArchiveAll: setProjectToArchive,
    onToggleSessionPin: togglePinSession,
    onToggleSessionArchive: requestToggleSessionArchive,
    onRenameSession: renameSession,
  }

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pb-2 pt-4">
        <div className="flex min-h-7 items-center justify-between">
          <button
            type="button"
            onClick={goHome}
            className="min-w-0 text-left text-base font-semibold"
          >
            {tr('Agent 工作台', 'Agent workspace')}
          </button>
        </div>

        <SidebarMenu className="mt-3">
          {allowed('sessions.run') && (
            <SidebarMenuItem>
              <SidebarMenuButton
                className="h-10 font-medium"
                isActive={page === 'home'}
                onClick={goHome}
              >
                <Plus />
                <span>{t('actions.newSession')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {allowed('devices.read') && (
          <DevicesSection
            connectors={connectors}
            isLoading={isLoading}
            page={page}
            activeConnectorId={activeConnectorId}
            onOpenDevice={navigateToDevice}
            onPairDevice={() => setPairOpen(true)}
          />
        )}

        <PinnedSection
          projects={sidebarShowsSessions ? [] : pinnedProjects}
          sessions={pinnedSessions}
          isLoading={isLoading}
          projectController={projectController}
          projectSessionStatus={projectSessionStatus}
          onOpenSession={openSession}
          onToggleSessionPin={togglePinSession}
          onToggleSessionArchive={requestToggleSessionArchive}
          onRenameSession={renameSession}
        />

        {sidebarShowsSessions && allowed('sessions.read') ? (
          <RecentSessionsSection
            label={t('sections.sessions')}
            sessions={allSessions}
            isLoading={isLoading}
            activeSessionId={activeSessionId}
            onMarkAllRead={markAllRead}
            onOpenSession={openSession}
            onToggleSessionPin={togglePinSession}
            onToggleSessionArchive={requestToggleSessionArchive}
            onRenameSession={renameSession}
          />
        ) : allowed('projects.read') ? (
          <>
            {serverSessions.length > 0 && allowed('sessions.read') && (
              <RecentSessionsSection
                label={tr('服务端 Agent', 'Server Agent')}
                sessions={serverSessions}
                isLoading={isLoading}
                activeSessionId={activeSessionId}
                onMarkAllRead={markAllRead}
                onOpenSession={openSession}
                onToggleSessionPin={togglePinSession}
                onToggleSessionArchive={requestToggleSessionArchive}
                onRenameSession={renameSession}
              />
            )}
            <ProjectsSection
              projects={regularProjects}
              isLoading={isLoading}
              expanded={projectsExpanded}
              controller={projectController}
              sessionStatus={projectSessionStatus}
              onExpandedChange={setProjectsExpanded}
              onSessionStatusChange={setProjectSessionStatus}
              onAddProject={() => setProjectEditor({ mode: 'create' })}
            />
            {unassignedSessions.length > 0 ? (
              <RecentSessionsSection
                label={t('sections.unassignedSessions')}
                sessions={unassignedSessions}
                isLoading={isLoading}
                activeSessionId={activeSessionId}
                onMarkAllRead={markAllRead}
                onOpenSession={openSession}
                onToggleSessionPin={togglePinSession}
                onToggleSessionArchive={requestToggleSessionArchive}
                onRenameSession={renameSession}
              />
            ) : null}
          </>
        ) : null}
      </SidebarContent>

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        onConnectorCreated={() => {
          refreshData()
        }}
      />

      <ProjectEditorDialog
        editor={projectEditor}
        connectors={connectors}
        projects={projects}
        onOpenChange={(open) => {
          if (!open) setProjectEditor(null)
        }}
        onCreate={createProject}
        onUpdate={updateProject}
      />

      <ProjectConfirmationDialogs
        projectToArchive={projectToArchive}
        onProjectToArchiveChange={setProjectToArchive}
        onArchiveProjectSessions={archiveProjectSessions}
      />
    </Sidebar>
  )
}
