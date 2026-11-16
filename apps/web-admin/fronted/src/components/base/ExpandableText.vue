<script setup lang="ts">
import { computed, ref } from 'vue'

/** 长说明在原位置展开，避免卡片或弹窗再套一层滚动条；保留完整文本供阅读。 */
const props = withDefaults(
  defineProps<{ text: string; label?: string; lines?: number }>(),
  { label: '说明', lines: 4 },
)
const expanded = ref(false)
const collapsible = computed(
  () => props.text.length > 160 || props.text.split('\n').length > props.lines,
)
</script>

<template>
  <div class="expandable-text">
    <p
      :class="{ 'expandable-text-preview': collapsible && !expanded }"
      :style="{ '--text-preview-lines': lines }"
    >
      {{ text }}
    </p>
    <el-button
      v-if="collapsible"
      text
      :aria-expanded="expanded"
      :aria-label="`${expanded ? '收起' : '展开'}${label}`"
      @click="expanded = !expanded"
      >{{ expanded ? '收起' : '展开完整' + label }}</el-button
    >
  </div>
</template>

<style scoped>
.expandable-text {
  display: grid;
  min-width: 0;
  gap: var(--label-gap);
  justify-items: start;
}
.expandable-text p {
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.expandable-text-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--text-preview-lines);
  overflow: hidden;
}
.expandable-text .el-button {
  margin: 0;
}
</style>
