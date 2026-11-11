<script setup lang="ts">
/** 表单分区统一标题与帮助信息，不持有字段值或提交行为。 */
defineProps<{ title: string; description?: string }>()
</script>
<template>
  <section class="form-section">
    <header>
      <h3>{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
    </header>
    <div class="stack"><slot /></div>
  </section>
</template>
