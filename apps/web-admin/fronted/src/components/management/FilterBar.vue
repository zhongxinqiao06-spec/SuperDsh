<script setup lang="ts">
/** 筛选字段与页面动作按传入顺序相邻排列，搜索仅由表单提交触发。 */
defineEmits<{ submit: [] }>()
</script>
<template>
  <form
    class="filter-bar toolbar"
    role="search"
    @submit.prevent="$emit('submit')"
  >
    <slot />
    <slot name="actions" />
  </form>
</template>
