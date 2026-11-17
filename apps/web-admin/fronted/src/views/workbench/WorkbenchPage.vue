<script setup lang="ts">
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { useWorkbench } from '@/composables/workbench/use-workbench'
import { useProjectManager } from '@/composables/workbench/use-project-manager'
import { useTimelineScroll } from '@/composables/workbench/use-timeline-scroll'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import { canControlSession } from '@/utils/workbench/session-access'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import TimelineList from './components/TimelineList.vue'
import InteractionCard from './components/InteractionCard.vue'
import WorkspaceFilesPane from '@/views/workspace-files/components/WorkspaceFilesPane.vue'
import TerminalPane from '@/views/terminal/components/TerminalPane.vue'
import DeviceManager from '@/views/devices/components/DeviceManager.vue'
import SessionResults from './components/SessionResults.vue'
import SessionShares from './components/SessionShares.vue'
import OfficeComposer from './components/OfficeComposer.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import type { WorkspaceProject } from '@/types/workbench/models'

/** 工作台页面装配领域用例与展示组件，Office 等能力由绑定智能体与工具提供。 */
const workspace = useWorkbench(),
  auth = useAuthStore(),
  preferences = usePreferences()
const projectManager = useProjectManager(
  workspace.devices,
  workspace.projects,
  workspace.reload,
)
const showFiles = ref(false),
  showTerminal = ref(false),
  showDevices = ref(false)
const deviceTarget = ref(''),
  pairingRequested = ref(false)
function openDevice(id = '', pair = false): void {
  deviceTarget.value = id
  pairingRequested.value = pair
  showDevices.value = true
}
function newSession(project?: WorkspaceProject): void {
  workspace.fresh()
  workspace.project.value =
    project?.id ?? workspace.runtime.agent?.projectId ?? ''
  if (project) workspace.draft.value.deviceId = project.connectorId
  else if (workspace.runtime.agent?.connectorId)
    workspace.draft.value.deviceId = workspace.runtime.agent.connectorId
}
const showSidebar = ref(!window.matchMedia('(max-width: 800px)').matches)
const showResults = ref(!window.matchMedia('(max-width: 1100px)').matches)
const results = ref<InstanceType<typeof SessionResults> | null>(null)
const shares = ref<InstanceType<typeof SessionShares> | null>(null)
const filePane = ref<InstanceType<typeof WorkspaceFilesPane> | null>(null)
const timelineHost = ref<HTMLElement | null>(null),
  timelineContent = ref<HTMLElement | null>(null)
const timelineScroll = useTimelineScroll(
  timelineHost,
  timelineContent,
  workspace.selected,
)
const connector = computed(
  () =>
    workspace.snapshot.value?.session.connectorId ??
    workspace.draft.value.deviceId,
)
const workspaceRoot = computed(
  () =>
    workspace.snapshot.value?.session.cwd ??
    workspace.projects.value.find(
      (project) => project.id === workspace.project.value,
    )?.workspacePath ??
    '',
)
const canControl = computed(
  () =>
    auth.can('sessions.run') &&
    canControlSession(workspace.snapshot.value?.session),
)
const notices = computed(() =>
  [
    ...(workspace.snapshot.value?.notices ?? []),
    ...(workspace.snapshot.value?.approvals ?? []),
  ].filter((item) =>
    ['open', 'responding'].includes(String(item.status ?? 'open')),
  ),
)
async function closeFiles(done: () => void): Promise<void> {
  if (!filePane.value || (await filePane.value.beforeClose())) done()
}
</script>

<template>
  <section
    class="workbench-page"
    :class="{ 'is-empty': !workspace.selected.value }"
  >
    <WorkspaceSidebar
      v-show="showSidebar"
      v-model:search="workspace.search.value"
      v-model:archived="workspace.archived.value"
      :projects="workspace.projects.value"
      :devices="workspace.devices.value"
      :can-devices="auth.can('devices.read')"
      :can-pair="auth.can('devices.manage')"
      :can-projects="auth.can('projects.read')"
      :can-manage-projects="auth.can('projects.manage')"
      :can-sessions="auth.can('sessions.read')"
      :can-run="auth.can('sessions.run')"
      :sessions-only="preferences.sidebarSessions"
      :sessions="workspace.sessions.value"
      :selected="workspace.selected.value"
      :session-busy="workspace.editingSession.value"
      :project-busy="projectManager.mutation.busy.value"
      :has-more="!!workspace.nextCursor.value"
      @select="workspace.select"
      @fresh="newSession()"
      @filter="workspace.reload"
      @create-project="projectManager.edit('new')"
      @project-action="projectManager.action"
      @project-session="newSession"
      @mark-all-read="projectManager.markAllRead"
      @device="openDevice"
      @pair="openDevice('', true)"
      @more="workspace.moreSessions"
      @action="workspace.updateSession"
    />
    <main class="workbench-main">
      <header class="workbench-toolbar">
        <el-button
          text
          class="workbench-sidebar-toggle"
          :aria-expanded="showSidebar"
          aria-label="切换会话侧栏"
          @click="showSidebar = !showSidebar"
          ><AppIcon name="panel-left" /><span class="workbench-action-label"
            >会话</span
          ></el-button
        >
        <div v-if="workspace.selected.value" class="workbench-heading">
          <h1>
            {{ workspace.snapshot.value?.session.title ?? 'Agent 工作台' }}
          </h1>
          <small role="status"
            >{{
              workspace.snapshot.value?.session.status ??
              workspace.runtime.agent?.status ??
              '准备中'
            }}
            <template v-if="workspace.selected.value">
              · {{ workspace.streamStatus.value }}</template
            ></small
          >
        </div>
        <el-button
          v-if="auth.can('devices.read')"
          text
          aria-label="设备"
          @click="openDevice()"
          ><AppIcon name="monitor" /><span class="workbench-action-label"
            >设备</span
          ></el-button
        >
        <el-button
          text
          aria-label="文件"
          :disabled="!connector || !auth.can('files.read')"
          @click="showFiles = true"
          ><AppIcon name="folder" /><span class="workbench-action-label"
            >文件</span
          ></el-button
        ><el-button
          text
          aria-label="终端"
          :disabled="!connector || !auth.can('terminal.use')"
          @click="showTerminal = true"
          ><AppIcon name="terminal" /><span class="workbench-action-label"
            >终端</span
          ></el-button
        ><el-button
          v-if="workspace.selected.value"
          text
          aria-label="同步"
          @click="workspace.sync"
          ><AppIcon name="refresh-cw" /><span class="workbench-action-label"
            >同步</span
          ></el-button
        ><el-button
          v-if="workspace.selected.value"
          text
          aria-label="分享"
          @click="shares?.show()"
          ><AppIcon name="share-2" /><span class="workbench-action-label"
            >分享</span
          ></el-button
        >
        <el-button
          v-if="workspace.selected.value && auth.can('files.read')"
          text
          aria-label="成果预览"
          :aria-expanded="showResults"
          @click="showResults = !showResults"
          ><AppIcon name="file-text" /><span class="workbench-action-label"
            >成果预览</span
          ></el-button
        >
      </header>
      <el-alert
        v-if="
          projectManager.mutation.error.value && !projectManager.editing.value
        "
        :title="projectManager.mutation.error.value"
        type="error"
        :closable="false"
      />
      <el-alert
        v-if="workspace.error.value || workspace.runtime.error"
        :title="workspace.error.value || workspace.runtime.error"
        type="error"
        :closable="false"
      />
      <el-alert
        v-if="workspace.runtime.agent?.error"
        :title="workspace.runtime.agent.error"
        type="error"
        :closable="false"
      />
      <div class="office-conversation-layout">
        <div class="workbench-conversation">
          <header v-if="!workspace.selected.value" class="workbench-welcome">
            <h2>接下来要构建什么？</h2>
          </header>
          <el-alert
            v-if="workspace.snapshot.value?.session.archived"
            title="此会话已归档，取消归档后可继续对话"
            type="info"
            :closable="false"
          />
          <el-alert
            v-if="
              workspace.snapshot.value &&
              !workspace.snapshot.value.session.takeover &&
              !workspace.snapshot.value.session.archived
            "
            title="当前会话为只读，接管后可以发送消息和控制任务"
            type="info"
            :closable="false"
          />
          <el-alert
            v-if="workspace.shareUrl.value"
            :title="workspace.shareUrl.value"
            description="此链接包含创建时的会话快照，可以复制分享。"
            type="success"
            :closable="true"
            @close="workspace.shareUrl.value = ''"
          />
          <div
            v-show="
              !!workspace.selected.value ||
              !!workspace.timeline.value.length ||
              !!notices.length
            "
            ref="timelineHost"
            class="workbench-timeline"
            @scroll.passive="timelineScroll.scroll"
          >
            <div ref="timelineContent" class="workbench-timeline-content">
              <TimelineList
                :items="workspace.timeline.value"
                :has-more="workspace.snapshot.value?.timeline.hasMore"
                :can-share="!!workspace.selected.value"
                @share="shares?.show($event)"
                @older="timelineScroll.older(workspace.older)"
                @attachment="results?.attachment($event)"
              /><InteractionCard
                v-for="notice in notices"
                :key="notice.id"
                :notice="notice"
                :session-id="workspace.selected.value || undefined"
                :disabled="
                  workspace.sending.value ||
                  workspace.responding.value ||
                  !canControl ||
                  notice.status === 'responding'
                "
                @respond="workspace.respond"
              />
            </div>
          </div>
          <OfficeComposer :workspace="workspace" />
          <p class="composer-note">未发送的草稿会自动保留，请核实重要信息。</p>
        </div>
        <ScrollPanel
          v-if="workspace.selected.value && auth.can('files.read')"
          v-show="showResults"
          as="aside"
          class="office-results-pane"
          label="会话成果"
        >
          <template #header
            ><div class="office-results-heading">
              <h2>会话成果</h2>
              <el-button text aria-label="收起成果" @click="showResults = false"
                ><AppIcon name="x"
              /></el-button></div
          ></template>
          <SessionResults
            ref="results"
            :session-id="workspace.selected.value"
            :can-write="auth.can('files.write')"
          />
        </ScrollPanel>
      </div>
    </main>
    <SessionShares ref="shares" :session-id="workspace.selected.value" />
    <ProjectEditor
      :vm="projectManager"
      @update:draft="projectManager.updateDraft"
      @update:path="projectManager.updatePath"
      @close="projectManager.close"
      @close-browser="projectManager.closeBrowser"
      @save="projectManager.save"
      @browse="projectManager.browse"
      @choose-directory="projectManager.chooseDirectory"
    />
    <el-drawer
      v-model="showFiles"
      title="工作区文件"
      class="workbench-drawer"
      size="70%"
      destroy-on-close
      :before-close="closeFiles"
      ><WorkspaceFilesPane
        ref="filePane"
        :connector-id="connector"
        :root="workspaceRoot"
    /></el-drawer>
    <el-drawer
      v-model="showTerminal"
      title="设备终端"
      class="workbench-drawer"
      size="65%"
      destroy-on-close
      ><TerminalPane :connector-id="connector" :root="workspaceRoot"
    /></el-drawer>
    <el-drawer
      v-model="showDevices"
      title="我的设备与运行实例"
      class="workbench-drawer"
      size="75%"
      destroy-on-close
      ><DeviceManager
        :initial-device-id="deviceTarget"
        :pair-on-open="pairingRequested"
        @changed="workspace.reload"
    /></el-drawer>
  </section>
</template>
