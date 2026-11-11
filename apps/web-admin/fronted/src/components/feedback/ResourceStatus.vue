<script setup lang="ts">
/** 资源状态不持有请求；刷新保留已有内容，错误优先于空结果呈现。 */
withDefaults(
  defineProps<{
    loading?: boolean
    error?: string
    hasData?: boolean
    empty?: boolean
    emptyTitle?: string
    emptyDescription?: string
  }>(),
  { emptyTitle: '暂无数据', error: '', emptyDescription: '' },
)
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" class="resource-loading" role="status" aria-live="polite">
    {{ hasData ? '正在更新…' : '加载中…' }}
  </div>
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    show-icon
  >
    <template #default>
      <el-button link @click="$emit('retry')">重试</el-button>
    </template>
  </el-alert>
  <div v-else-if="!loading && empty" class="resource-empty" role="status">
    <strong>{{ emptyTitle }}</strong>
    <p v-if="emptyDescription">{{ emptyDescription }}</p>
    <slot />
  </div>
</template>

<style scoped>
.resource-empty {
  padding: 40px 24px;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--card);
}
.resource-empty strong {
  font-size: 15px;
  font-weight: 500;
}
.resource-empty p {
  margin: 8px 0 0;
  color: var(--muted-foreground);
  font-size: 13px;
}
</style>
