<script setup lang="ts">
import { computed } from 'vue'
import RowActions from '@/components/management/RowActions.vue'
import type { RowAction } from '@/types/common/management'
/** 智能体桌面与窄屏复用同一操作集合，试用权限和发布状态不因布局而变化。 */
const props = defineProps<{
  published: boolean
  canRun: boolean
  busy?: boolean
}>()
defineEmits<{ action: [key: string] }>()
const actions = computed<RowAction[]>(() => [
  { key: 'edit', label: '编辑' },
  ...(props.published && props.canRun ? [{ key: 'trial', label: '试用' }] : []),
  { key: 'check', label: '发布检查' },
  { key: 'publish', label: props.published ? '取消发布' : '发布' },
  { key: 'delete', label: '删除', danger: true },
])
</script>
<template>
  <RowActions
    :actions="actions"
    :busy="busy"
    @action="$emit('action', $event)"
  />
</template>
