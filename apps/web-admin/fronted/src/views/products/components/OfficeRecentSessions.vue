<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import DateTime from '@/components/base/DateTime.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { conversationApi } from '@/api/workbench/conversation-api'
import { useResource } from '@/composables/use-resource'
import { sessionStatusLabel } from '@/utils/workbench/session-access'
defineProps<{ canOpen: boolean }>()
const recent = useResource((signal) =>
  conversationApi.sessions(
    { product: 'office', archived: 'false', limit: '4' },
    signal,
  ),
)
</script>
<template>
  <section class="office-recent" aria-label="最近会话">
    <header class="office-section-heading">
      <h2>最近会话</h2>
      <router-link to="/workspace/history"
        >查看全部 <AppIcon name="arrow-right" :size="14"
      /></router-link>
    </header>
    <ResourceStatus
      :loading="recent.loading.value"
      :error="recent.error.value"
      @retry="recent.reload"
    />
    <p
      v-if="recent.data.value && !recent.data.value.sessions.length"
      class="office-empty"
    >
      暂无办公会话
    </p>
    <component
      :is="canOpen ? 'router-link' : 'div'"
      v-for="session in recent.data.value?.sessions ?? []"
      :key="session.id"
      :to="
        canOpen
          ? '/workspace/session/' + encodeURIComponent(session.id)
          : undefined
      "
      class="office-session-row"
    >
      <span class="office-session-icon"><AppIcon name="message-square" /></span>
      <strong>{{ session.title }}</strong
      ><small>{{ sessionStatusLabel(session.status) }}</small>
      <DateTime :value="session.lastActivityAt ?? session.sortAt" /><AppIcon
        v-if="canOpen"
        name="chevron-right"
        :size="14"
      />
    </component>
  </section>
</template>
