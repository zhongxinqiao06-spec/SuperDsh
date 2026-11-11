<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import SidebarSessionItem from './SidebarSessionItem.vue'
import SidebarProjectItem from './SidebarProjectItem.vue'
import { sidebarGroups } from '@/utils/workbench/sidebar-groups'
import type {
  SessionAction,
  WorkspaceConnector,
  WorkspaceProject,
  WorkspaceSession,
} from '@/types/workbench/models'
/** 侧栏遵循设备、置顶、服务器会话和项目树的旧组织方式；权限控制只呈现可操作入口。 */
const props = defineProps<{
  devices: WorkspaceConnector[]
  projects: WorkspaceProject[]
  sessions: WorkspaceSession[]
  selected: string
  search: string
  archived: boolean
  sessionBusy: boolean
  projectBusy: boolean
  hasMore?: boolean
  sessionsOnly?: boolean
  canDevices: boolean
  canPair: boolean
  canProjects: boolean
  canManageProjects: boolean
  canSessions: boolean
  canRun: boolean
}>()
defineEmits<{
  select: [id: string]
  fresh: []
  filter: []
  'update:search': [value: string]
  'update:archived': [value: boolean]
  createProject: []
  more: []
  markAllRead: []
  device: [id: string]
  pair: []
  projectSession: [project: WorkspaceProject]
  projectAction: [
    project: WorkspaceProject,
    action: 'edit' | 'pin' | 'archive' | 'restore',
  ]
  action: [session: WorkspaceSession, action: SessionAction]
}>()
const devicesOpen = ref(true),
  projectsOpen = ref(true),
  filterOpen = ref(false),
  connectorFilter = ref(''),
  runtimeFilter = ref('')
const runtimes = computed(() => [
  ...new Set(props.sessions.map((item) => item.runtime)),
])
function filterRows(items: WorkspaceSession[]): WorkspaceSession[] {
  return items.filter(
    (item) =>
      (!connectorFilter.value || item.connectorId === connectorFilter.value) &&
      (!runtimeFilter.value || item.runtime === runtimeFilter.value),
  )
}
const groups = computed(() =>
  sidebarGroups(props.devices, props.projects, props.sessions, props.archived),
)
const sessionGroups = computed(() =>
  props.sessionsOnly
    ? [{ label: '会话', kind: 'all', items: filterRows(groups.value.all) }]
    : [
        { label: '服务端 Agent', kind: 'server', items: groups.value.server },
        {
          label: '未分组会话',
          kind: 'unassigned',
          items: groups.value.unassigned,
        },
      ]
        .filter((group) => group.items.length)
        .map((group) => ({ ...group, items: filterRows(group.items) })),
)
</script>
<template>
  <aside class="workspace-sidebar">
    <strong class="workspace-sidebar-title">Agent 工作台</strong>
    <el-button
      v-if="canRun"
      class="workspace-new-session"
      @click="$emit('fresh')"
      ><AppIcon name="plus" />新会话</el-button
    >
    <section v-if="canDevices" class="sidebar-group sidebar-devices-group">
      <div class="workspace-section-heading">
        <button
          :aria-expanded="devicesOpen"
          @click="devicesOpen = !devicesOpen"
        >
          设备<AppIcon
            name="chevron-down"
            :class="{ collapsed: !devicesOpen }"
          /></button
        ><el-button
          v-if="canPair"
          text
          aria-label="连接设备"
          @click="$emit('pair')"
          ><AppIcon name="plus"
        /></el-button>
      </div>
      <template v-if="devicesOpen"
        ><button
          v-for="device in devices"
          :key="device.id"
          class="sidebar-device"
          @click="$emit('device', device.id)"
        >
          <i class="session-status-dot" :data-status="device.status" /><span>{{
            device.name
          }}</span>
        </button>
        <p v-if="!devices.length" class="workspace-empty">
          暂无设备。
        </p></template
      >
    </section>
    <section
      v-if="
        (canSessions && groups.pinned.length) ||
        (!sessionsOnly && canProjects && groups.pinnedProjects.length)
      "
      class="sidebar-group sidebar-pinned-group"
    >
      <div class="workspace-section-heading">置顶</div>
      <SidebarSessionItem
        v-for="item in groups.pinned"
        :key="item.id"
        :session="item"
        :selected="selected"
        :busy="sessionBusy"
        :mutable="canRun"
        @select="$emit('select', $event)"
        @action="(item, action) => $emit('action', item, action)"
      />
      <template v-if="!sessionsOnly"
        ><SidebarProjectItem
          v-for="group in groups.pinnedProjects"
          :key="group.project.id"
          v-bind="group"
          :selected="selected"
          :session-busy="sessionBusy"
          :busy="projectBusy"
          :mutable="canManageProjects"
          :can-run="canRun"
          @select="$emit('select', $event)"
          @fresh="$emit('projectSession', $event)"
          @project-action="
            (item, action) => $emit('projectAction', item, action)
          "
          @action="(item, action) => $emit('action', item, action)"
      /></template>
    </section>
    <section
      v-if="!sessionsOnly && canProjects"
      class="sidebar-group sidebar-projects-group"
    >
      <div class="workspace-section-heading">
        <button
          :aria-expanded="projectsOpen"
          @click="projectsOpen = !projectsOpen"
        >
          项目<AppIcon
            name="chevron-down"
            :class="{ collapsed: !projectsOpen }"
          /></button
        ><el-button
          v-if="canManageProjects"
          text
          aria-label="新建项目"
          @click="$emit('createProject')"
          ><AppIcon name="plus"
        /></el-button>
      </div>
      <template v-if="projectsOpen"
        ><SidebarProjectItem
          v-for="group in groups.projects"
          :key="group.project.id"
          v-bind="group"
          :selected="selected"
          :session-busy="sessionBusy"
          :busy="projectBusy"
          :mutable="canManageProjects"
          :can-run="canRun"
          @select="$emit('select', $event)"
          @fresh="$emit('projectSession', $event)"
          @project-action="
            (item, action) => $emit('projectAction', item, action)
          "
          @action="(item, action) => $emit('action', item, action)"
        />
        <p v-if="!groups.projects.length" class="workspace-empty">
          还没有项目。
        </p></template
      >
    </section>
    <section
      v-for="group in canSessions ? sessionGroups : []"
      :key="group.label"
      class="sidebar-group"
      :class="'sidebar-' + group.kind + '-group'"
    >
      <div class="workspace-section-heading">
        <span>{{ group.label }}</span
        ><el-button text aria-label="全部标为已读" @click="$emit('markAllRead')"
          ><AppIcon name="check"
        /></el-button>
      </div>
      <SidebarSessionItem
        v-for="item in group.items"
        :key="item.id"
        :session="item"
        :selected="selected"
        :busy="sessionBusy"
        :mutable="canRun"
        @select="$emit('select', $event)"
        @action="(item, action) => $emit('action', item, action)"
      />
      <p v-if="!group.items.length" class="workspace-empty">暂无匹配的会话。</p>
    </section>
    <template v-if="canSessions">
      <el-button
        text
        class="sidebar-filter-toggle"
        @click="filterOpen = !filterOpen"
        ><AppIcon name="search" />{{
          archived ? '已归档' : '筛选会话'
        }}</el-button
      >
      <div v-if="filterOpen" class="sidebar-filter-panel">
        <el-select v-model="connectorFilter" aria-label="筛选设备"
          ><el-option value="" label="全部设备" /><el-option
            v-for="device in devices"
            :key="device.id"
            :value="device.id"
            :label="device.name"
        /></el-select>
        <el-select v-model="runtimeFilter" aria-label="筛选运行引擎"
          ><el-option value="" label="全部引擎" /><el-option
            v-for="runtime in runtimes"
            :key="runtime"
            :value="runtime"
            :label="runtime.toUpperCase()"
        /></el-select>
        <el-input
          :model-value="search"
          placeholder="搜索会话"
          clearable
          @update:model-value="$emit('update:search', $event)"
          @keyup.enter="$emit('filter')"
          @clear="$emit('filter')"
        /><el-switch
          :model-value="archived"
          active-text="已归档"
          inactive-text="进行中"
          @update:model-value="$emit('update:archived', Boolean($event))"
        />
      </div>
    </template>
    <el-button v-if="hasMore" class="sidebar-more" text @click="$emit('more')"
      >加载更多会话</el-button
    >
  </aside>
</template>
