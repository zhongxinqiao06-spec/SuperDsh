<script setup lang="ts">
/** 页面主标题只呈现页面名称，操作和状态由所属区域提供。 */
defineProps<{ title: string }>()
</script>
<template>
  <header class="page-heading">
    <h1>{{ title }}</h1>
  </header>
</template>
