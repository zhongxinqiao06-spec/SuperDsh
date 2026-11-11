<script setup lang="ts">
import { computed } from 'vue'
import { resolveIcon } from '@/utils/icons'

/** 统一线框图标仅负责展示；操作名称由宿主按钮或链接提供。 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 16,
})
const nodes = computed(() => resolveIcon(props.name))
</script>

<template>
  <svg
    class="app-icon"
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <component
      :is="node[0]"
      v-for="(node, index) in nodes"
      :key="index"
      v-bind="node[1]"
    />
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
