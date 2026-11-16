<script setup lang="ts">
import SessionActionMenu from './SessionActionMenu.vue'
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
    <SessionActionMenu
      v-if="mutable"
      :session="session"
      :busy="busy"
      @action="$emit('action', session, $event)"
    />
  </div>
</template>
