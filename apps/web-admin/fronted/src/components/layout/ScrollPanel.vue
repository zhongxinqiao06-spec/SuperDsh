<script setup lang="ts">
import { ref, watch } from 'vue'
/** 标题和操作不随正文滚动；resetKey 改变时回到正文起点，不持有领域数据。 */
const props = withDefaults(
  defineProps<{ label: string; as?: 'section' | 'aside'; resetKey?: string }>(),
  {
    as: 'section',
    resetKey: undefined,
  },
)
const body = ref<HTMLElement>()
watch(
  () => props.resetKey,
  () => body.value?.scrollTo({ top: 0, left: 0, behavior: 'instant' }),
  { flush: 'post' },
)
</script>

<template>
  <component :is="as" class="scroll-panel" :aria-label="label">
    <header v-if="$slots.header" class="scroll-panel__header">
      <slot name="header" />
    </header>
    <div
      ref="body"
      class="scroll-panel__body"
      role="region"
      :aria-label="`${label}内容`"
      tabindex="0"
    >
      <slot />
    </div>
    <footer v-if="$slots.footer" class="scroll-panel__footer">
      <slot name="footer" />
    </footer>
  </component>
</template>

<style scoped>
.scroll-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.scroll-panel__header,
.scroll-panel__footer {
  flex: none;
  min-width: 0;
  padding: var(--field-gap);
  background: var(--card);
}
.scroll-panel__header {
  border-bottom: 1px solid var(--border);
}
.scroll-panel__header :deep(h2),
.scroll-panel__header :deep(h3) {
  margin: 0;
}
.scroll-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scroll-padding: var(--control-gap);
  padding: var(--field-gap);
}
.scroll-panel__body:focus-visible {
  outline-offset: -3px;
}
.scroll-panel__footer {
  border-top: 1px solid var(--border);
}
</style>
