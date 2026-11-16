<script setup lang="ts">
import { ref } from 'vue'
import type { DropdownInstance } from 'element-plus'
import AppIcon from '@/components/base/AppIcon.vue'
import type { SessionAction, WorkspaceSession } from '@/types/workbench/models'
/** 两个历史入口共享操作及键盘返回焦点。 */
defineProps<{ session: WorkspaceSession; busy: boolean }>()
defineEmits<{ action: [action: SessionAction] }>()
const dropdown = ref<DropdownInstance>()
const trigger = ref<HTMLButtonElement>()
/** 菜单可能挂载在侧栏以外，按 Esc 后将焦点还给对应会话的入口。 */
function closeMenu(): void {
  dropdown.value?.handleClose()
  trigger.value?.focus()
}
</script>
<template>
  <el-dropdown
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
        <el-dropdown-item :disabled="busy" @click="$emit('action', 'rename')"
          >重命名</el-dropdown-item
        >
        <el-dropdown-item :disabled="busy" @click="$emit('action', 'pin')">{{
          session.pinned ? '取消置顶' : '置顶'
        }}</el-dropdown-item>
        <el-dropdown-item
          :disabled="busy"
          @click="$emit('action', 'archive')"
          >{{ session.archived ? '取消归档' : '归档' }}</el-dropdown-item
        >
        <el-dropdown-item
          divided
          :disabled="busy"
          @click="$emit('action', 'delete')"
          ><span class="danger-action">删除</span></el-dropdown-item
        >
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
