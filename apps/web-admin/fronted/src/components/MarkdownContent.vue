<script setup lang="ts">
import { computed } from 'vue'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import { renderMarkdown } from '@/utils/markdown-renderer'
import MermaidDiagram from './MermaidDiagram.vue'
/** 通用富文本展示：表格、任务列表、公式、代码和图表共享同一安全渲染入口。 */
const props = defineProps<{ content: string }>()
const fragments = computed(() => renderMarkdown(props.content))
</script>
<template>
  <div class="markdown-content">
    <template v-for="(fragment, index) in fragments" :key="index"
      ><MermaidDiagram
        v-if="fragment.kind === 'diagram'"
        :source="fragment.content" />
      <div v-else v-html="fragment.content"
    /></template>
  </div>
</template>
<style scoped>
.markdown-content {
  overflow-wrap: anywhere;
  line-height: 1.7;
  min-width: 0;
}
.markdown-content :deep(pre) {
  overflow: auto;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.markdown-content :deep(pre code) {
  background: transparent;
  color: var(--el-text-color-primary);
}
.markdown-content :deep(blockquote) {
  border-left: 3px solid var(--el-border-color);
  margin-left: 0;
  padding-left: 16px;
  color: var(--el-text-color-secondary);
}
.markdown-content :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}
.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 6px 12px;
}
.markdown-content :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
}
</style>
