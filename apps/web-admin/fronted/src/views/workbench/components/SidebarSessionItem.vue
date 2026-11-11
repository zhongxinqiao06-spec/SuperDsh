<script setup lang="ts">
import { ref } from 'vue'
import type { DropdownInstance } from 'element-plus'
import AppIcon from '@/components/base/AppIcon.vue'
import type { SessionAction, WorkspaceSession } from '@/types/workbench/models'
/** 所有侧栏分组共享会话操作，事件仍由工作台用例负责授权与持久化。 */
defineProps<{
  session: WorkspaceSession
  selected: string
  mutable: boolean
  busy: boolean
}>()
defineEmits<{
  select: [id: string]
  action: [session: WorkspaceSession, action: SessionAction]
}>()
const dropdown = ref<DropdownInstance>()
const trigger = ref<HTMLButtonElement>()
/** 菜单可能挂载在侧栏以外，按 Esc 后将焦点还给对应会话的入口。 */
function closeMenu(): void {
  dropdown.value?.handleClose()
  trigger.value?.focus()
}
</script>
<template>
  <div class="sidebar-session" :class="{ selected: selected === session.id }">
    <button
      class="session-main"
      :aria-current="selected === session.id ? 'page' : undefined"
      :title="session.title"
      @click="$emit('select', session.id)"
    >
      <AppIcon :name="session.pinned ? 'pin' : 'message-square'" />
      <span class="session-text"
        ><span>{{ session.title }}</span
        ><small
          ><i class="session-status-dot" :data-status="session.status" />{{
            session.status
          }}{{ session.unread ? ' · 未读' : '' }}</small
        ></span
      >
    </button>
    <el-dropdown
      v-if="mutable"
      ref="dropdown"
      class="session-menu"
      trigger="click"
      placement="bottom-end"
      :show-arrow="false"
      :disabled="busy"
    >
      <button
        ref="trigger"
        type="button"
        class="session-menu-trigger"
        aria-label="会话操作"
        :disabled="busy"
        @keydown.esc.stop.prevent="closeMenu"
      >
        <AppIcon name="ellipsis" />
      </button>
      <template #dropdown>
        <el-dropdown-menu @keydown.esc.stop.prevent="closeMenu">
          <el-dropdown-item
            :disabled="busy"
            @click="$emit('action', session, 'rename')"
            >重命名</el-dropdown-item
          >
          <el-dropdown-item
            :disabled="busy"
            @click="$emit('action', session, 'pin')"
            >{{ session.pinned ? '取消置顶' : '置顶' }}</el-dropdown-item
          >
          <el-dropdown-item
            :disabled="busy"
            @click="$emit('action', session, 'archive')"
            >{{ session.archived ? '取消归档' : '归档' }}</el-dropdown-item
          >
          <el-dropdown-item
            divided
            :disabled="busy"
            @click="$emit('action', session, 'delete')"
            ><span class="danger-action">删除</span></el-dropdown-item
          >
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>
