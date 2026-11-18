<script setup lang="ts">
import type { StudioAsset } from '@/types/studio/studio'
import { useAuthStore } from '@/store/modules/auth-store'
import { mediaKind } from '@/utils/studio/media-labels'
import StudioMedia from '../StudioMedia.vue'

/** 场次、镜头和剪辑共用可见的已选素材摘要，选择器由宿主携带业务上下文打开。 */
defineProps<{
  label: string
  assets: StudioAsset[]
  project: string
  readonly?: boolean
  addLabel?: string
  empty?: string
  removable?: boolean
}>()
const emit = defineEmits<{ choose: []; remove: [id: string] }>()
const auth = useAuthStore()
</script>
<template>
  <section class="reference-group" :aria-label="label">
    <div class="toolbar">
      <strong>{{ label }}</strong
      ><span class="toolbar-spacer" /><el-button
        v-if="!readonly"
        link
        @click="emit('choose')"
        >{{ addLabel || '选择素材' }}</el-button
      >
    </div>
    <p v-if="!assets.length" class="studio-meta">{{ empty || '暂未选用' }}</p>
    <div v-for="asset in assets" :key="asset.id" class="reference-summary">
      <span
        v-if="
          asset.fileId &&
          auth.can('files.read') &&
          mediaKind(asset.kind) !== 'audio'
        "
        class="reference-thumbnail"
        ><StudioMedia
          :project="project"
          :asset="asset.id"
          :kind="mediaKind(asset.kind)"
          lazy
      /></span>
      <span class="reference-copy"
        ><strong>{{ asset.name }}</strong
        ><small
          >{{ asset.variantName || '当前设定' }} · 版本
          {{ asset.version ?? '—' }}</small
        ></span
      >
      <el-button
        v-if="!readonly && removable !== false"
        link
        :aria-label="'移除' + asset.name + '的引用'"
        @click="emit('remove', asset.id)"
        >移除</el-button
      >
    </div>
  </section>
</template>
<style scoped>
.reference-group {
  display: grid;
  gap: var(--control-gap);
  min-width: 0;
}
.reference-group p {
  margin: 0;
}
.reference-summary {
  display: flex;
  gap: var(--control-gap);
  align-items: center;
  min-width: 0;
  padding: var(--control-gap);
  background: var(--muted);
  border-radius: var(--radius-control, 8px);
}
.reference-thumbnail {
  flex: 0 0 48px;
  height: 48px;
  overflow: hidden;
  border-radius: 4px;
}
.reference-thumbnail :deep(.studio-media),
.reference-thumbnail :deep(.studio-frame) {
  width: 100%;
  height: 100%;
  margin: 0;
  object-fit: contain;
}
.reference-copy {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 2px;
  overflow-wrap: anywhere;
}
.reference-copy strong {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.reference-copy small {
  color: var(--muted-foreground);
}
.reference-summary .el-button {
  flex-shrink: 0;
}
</style>
