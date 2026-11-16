<script setup lang="ts">
import type { useArtifactActions } from '@/composables/workbench/use-artifact-actions'
/** 会话侧栏与首页弹窗复用同一可信字节预览。 */
defineProps<{
  actions: Pick<
    ReturnType<typeof useArtifactActions>,
    'previewUrl' | 'previewType' | 'previewName'
  >
}>()
</script>
<template>
  <iframe
    v-if="actions.previewType.value === 'application/pdf'"
    :src="actions.previewUrl.value"
    title="成果预览"
    class="preview"
  />
  <img
    v-else
    :src="actions.previewUrl.value"
    :alt="actions.previewName.value"
    class="preview-image"
  />
</template>
