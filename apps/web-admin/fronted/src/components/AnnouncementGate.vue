<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { systemApi } from '@/api/service/system-api'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import MarkdownContent from '@/components/MarkdownContent.vue'
/** 已读状态按账号和发布时间隔离；新公告和换号都不能复用其他人的确认。 */
const auth = useAuthStore(),
  { tr } = usePreferences(),
  resource = useResource(systemApi.publicAnnouncement),
  acknowledgement = ref('')
const key = computed(
  () => `superdsh.announcement.${auth.session?.userId ?? ''}`,
)
function stored() {
  try {
    return localStorage.getItem(key.value) ?? ''
  } catch {
    return ''
  }
}
const open = computed(() =>
  Boolean(
    auth.session &&
    resource.data.value?.announcement &&
    resource.data.value.announcement.publishedAt !==
      (acknowledgement.value || stored()),
  ),
)
function acknowledge() {
  acknowledgement.value = resource.data.value?.announcement?.publishedAt ?? ''
  try {
    localStorage.setItem(key.value, acknowledgement.value)
  } catch {
    /* 存储不可用时，本次页面会话仍允许确认。 */
  }
}
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  timer = setInterval(() => void resource.reload(), 30_000)
})
onScopeDispose(() => clearInterval(timer))
</script>
<template>
  <el-dialog
    :model-value="open"
    :title="tr('平台公告', 'Platform announcement')"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    width="min(680px,94vw)"
    ><MarkdownContent
      :content="resource.data.value?.announcement?.markdown ?? ''"
    /><template #footer
      ><el-button type="primary" @click="acknowledge">{{
        tr('我已阅读', 'I have read this')
      }}</el-button></template
    ></el-dialog
  >
</template>
