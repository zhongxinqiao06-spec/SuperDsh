<script setup lang="ts">
import '@/assets/styles/settings.css'
/** 账号与服务配置共用摘要卡，编辑表单由具名动作和内容插槽装配。 */
defineProps<{ title: string; description?: string }>()
</script>
<template>
  <section class="settings-card">
    <header class="settings-card-header">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
      <slot name="action" />
    </header>
    <div v-if="$slots.default" class="settings-card-content"><slot /></div>
  </section>
</template>
