<script setup lang="ts">
import type { RowAction } from '@/types/common/management'
/** 直接展示记录操作，原生字段组在提交期间同时禁用声明式和插槽按钮。 */
withDefaults(defineProps<{ actions?: RowAction[]; busy?: boolean }>(), {
  actions: () => [],
})
defineEmits<{ action: [key: string] }>()
</script>
<template>
  <fieldset class="row-actions" :disabled="busy" aria-label="记录操作">
    <slot />
    <el-button
      v-for="action in actions"
      :key="action.key"
      link
      size="small"
      :type="action.danger ? 'danger' : undefined"
      :disabled="busy || action.disabled"
      :title="action.reason"
      @click="$emit('action', action.key)"
      >{{ action.label }}</el-button
    >
  </fieldset>
</template>
