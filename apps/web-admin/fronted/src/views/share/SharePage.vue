<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import { useRoute } from 'vue-router'
import { conversationApi } from '@/api/workbench/conversation-api'
import TimelineList from '@/views/workbench/components/TimelineList.vue'
import { apiUrl } from '@/utils/api-config'
import { errorMessage } from '@/utils/errors'
import type { TimelineItem } from '@/types/workbench/models'
/** 分享页只读取冻结快照，不建立登录会话或执行实时订阅。 */
const route = useRoute(),
  title = ref('会话分享'),
  items = ref<TimelineItem[]>([]),
  error = ref(''),
  loading = ref(true)
let disposed = false
onMounted(async () => {
  try {
    const value = await conversationApi.publicShare(
      String(route.params.shareId ?? route.params.id),
    )
    if (!disposed) {
      title.value = value.session.title
      items.value = value.timeline.items
    }
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
})
onScopeDispose(() => {
  disposed = true
})
function attachment(fileId: string): void {
  window.open(
    apiUrl(
      `/public/shares/${encodeURIComponent(String(route.params.shareId ?? route.params.id))}/attachments/${encodeURIComponent(fileId)}`,
    ),
    '_blank',
    'noopener,noreferrer',
  )
}
</script>
<template>
  <main v-loading="loading" class="share-page">
    <header class="share-page-heading">
      <span class="share-page-label">会话分享</span>
      <h1>{{ title }}</h1>
      <p>此页面展示分享时保存的会话内容。</p>
    </header>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    /><TimelineList v-else :items="items" @attachment="attachment" />
  </main>
</template>
