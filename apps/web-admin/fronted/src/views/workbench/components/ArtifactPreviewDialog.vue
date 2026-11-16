<script setup lang="ts">
import ArtifactPreviewContent from './ArtifactPreviewContent.vue'
import type { useArtifactActions } from '@/composables/workbench/use-artifact-actions'
/** 预览 URL 仅来自经过授权的 PDF 或图片字节。 */
defineProps<{
  actions: Pick<
    ReturnType<typeof useArtifactActions>,
    'previewUrl' | 'previewType' | 'previewName' | 'closePreview'
  >
}>()
</script>
<template>
  <el-dialog
    :model-value="!!actions.previewUrl.value"
    :title="actions.previewName.value"
    class="session-preview-dialog"
    width="85%"
    @close="actions.closePreview"
  >
    <ArtifactPreviewContent :actions="actions" />
  </el-dialog>
</template>
