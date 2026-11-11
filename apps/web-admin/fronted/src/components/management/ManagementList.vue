<script setup lang="ts">
import { ref, watch } from 'vue'

/** 页面主列表单独滚动，分页留在可见区域；切页后从第一条记录开始阅读。 */
const props = defineProps<{ page: number; pageSize: number }>()
const viewport = ref<HTMLElement>()
watch(
  () => [props.page, props.pageSize],
  () => viewport.value?.scrollTo({ top: 0 }),
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
