<script setup lang="ts">
import { useId } from 'vue'
/** 表单分区统一标题与帮助信息，不持有字段值或提交行为。 */
defineProps<{ title: string; description?: string; columns?: boolean }>()
const headingId = useId()
</script>
<template>
  <section class="form-section" :aria-labelledby="headingId">
    <header>
      <h3 :id="headingId">{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
    </header>
    <div :class="columns ? 'form-columns' : 'form-stack'"><slot /></div>
  </section>
</template>
