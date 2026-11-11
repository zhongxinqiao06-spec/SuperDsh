<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import { ref, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import SidebarSessionItem from './SidebarSessionItem.vue'
import type {
  SessionAction,
  WorkspaceProject,
  WorkspaceSession,
} from '@/types/workbench/models'
/** 项目折叠仅控制展示，新会话与批量动作通过事件交给上层用例。 */
const props = defineProps<{
  project: WorkspaceProject
  sessions: WorkspaceSession[]
  selected: string
  mutable: boolean
  busy: boolean
  sessionBusy: boolean
  canRun: boolean
}>()
defineEmits<{
  select: [id: string]
  fresh: [project: WorkspaceProject]
  projectAction: [
    project: WorkspaceProject,
    action: 'edit' | 'pin' | 'archive' | 'restore',
  ]
  action: [session: WorkspaceSession, action: SessionAction]
}>()
const expanded = ref(props.sessions.some((item) => item.id === props.selected))
watch(
  () => props.selected,
  (id) => {
    if (props.sessions.some((item) => item.id === id)) expanded.value = true
  },
)
</script>
<template>
  <div class="sidebar-project">
    <div class="sidebar-project-heading">
      <button
        :aria-expanded="expanded"
        :title="project.workspacePath"
        @click="expanded = !expanded"
      >
        <AppIcon :name="expanded ? 'folder-open' : 'folder'" /><span>{{
          project.name
        }}</span>
      </button>

      <el-button
        v-if="canRun"
        text
        aria-label="在项目中新建会话"
        @click="$emit('fresh', project)"
        ><AppIcon name="plus"
      /></el-button>
    </div>
    <RowActions v-if="mutable" :busy="busy" class="sidebar-record-actions"
      ><el-button link @click="$emit('projectAction', project, 'edit')"
        >编辑项目</el-button
      >
      <el-button link @click="$emit('projectAction', project, 'pin')">{{
        project.pinned ? '取消固定' : '固定项目'
      }}</el-button>
      <el-button link @click="$emit('projectAction', project, 'archive')"
        >归档全部会话</el-button
      >
      <el-button link @click="$emit('projectAction', project, 'restore')"
        >恢复全部会话</el-button
      ></RowActions
    >
    <div v-if="expanded" class="sidebar-project-sessions">
      <SidebarSessionItem
        v-for="item in sessions"
        :key="item.id"
        :session="item"
        :selected="selected"
        :busy="sessionBusy"
        :mutable="canRun"
        @select="$emit('select', $event)"
        @action="(item, action) => $emit('action', item, action)"
      />
      <p v-if="!sessions.length" class="workspace-empty">暂无会话。</p>
    </div>
  </div>
</template>
