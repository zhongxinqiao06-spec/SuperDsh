<script setup lang="ts">
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import type { Job } from '@/types/studio/studio'

/** 授权媒体沿用公共弹窗；限制竖屏画面高度，关闭时卸载播放器并释放播放状态。 */
defineProps<{ url: string; kind: Job['kind']; revision: number }>()
defineEmits<{ close: [] }>()
</script>

<template>
  <ManagementDialog
    :model-value="true"
    :title="`媒体预览 · 工程版本 ${revision}`"
    readonly
    width="min(960px, calc(100vw - 32px))"
    @update:model-value="(value) => !value && $emit('close')"
  >
    <div class="studio-media-preview">
      <audio v-if="kind === 'speech'" :src="url" controls autoplay />
      <img v-else-if="kind === 'image'" :src="url" alt="生成参考画面" />
      <video v-else :src="url" controls autoplay playsinline />
    </div>
  </ManagementDialog>
</template>

<style scoped>
.studio-media-preview {
  display: grid;
  min-width: 0;
  place-items: center;
}
.studio-media-preview video,
.studio-media-preview img {
  display: block;
  max-width: 100%;
  max-height: 65dvh;
  object-fit: contain;
  border-radius: var(--radius-control);
  background: var(--studio-monitor);
}
.studio-media-preview audio {
  width: 100%;
  max-width: 480px;
}
</style>
