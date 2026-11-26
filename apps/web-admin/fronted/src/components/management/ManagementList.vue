<script setup lang="ts">
import { ref, watch } from 'vue'

/** 切页后回到新一页首条记录，兼容常规列表滚动与矮窗口的整页滚动。 */
const props = defineProps<{ page: number; pageSize: number }>()
const viewport = ref<HTMLElement>()
watch(
  () => [props.page, props.pageSize],
  () => {
    const list = viewport.value
    if (!list) return
    if (getComputedStyle(list).overflowY !== 'visible') {
      list.scrollTop = 0
      return
    }
    const content = list.closest<HTMLElement>('.console-content')
    if (
      content &&
      list.getBoundingClientRect().top < content.getBoundingClientRect().top
    )
      list.scrollIntoView({ block: 'start' })
  },
  { flush: 'post' },
)
</script>
<template>
  <section class="management-list">
    <div
      ref="viewport"
      class="management-list-body"
      tabindex="0"
      role="region"
      aria-label="列表内容"
    >
      <slot />
    </div>
    <slot name="pagination" />
  </section>
</template>
