<script setup lang="ts">
import MarkdownContent from '@/components/MarkdownContent.vue'

/** 对话与导演共用的思考过程展示，默认收起，不混入正式回复。 */
defineProps<{ text: string }>()
</script>
<template>
  <details class="reasoning-details">
    <summary>思考过程</summary>
    <MarkdownContent :content="text" />
  </details>
</template>
<style scoped>
.reasoning-details {
  min-width: 0;
  color: var(--muted-foreground);
  font-size: var(--font-size-meta);
  overflow-wrap: anywhere;
}
.reasoning-details > .markdown-content {
  padding-top: var(--control-gap);
}
</style>
