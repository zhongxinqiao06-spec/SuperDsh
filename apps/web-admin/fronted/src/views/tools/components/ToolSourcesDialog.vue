<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
import ToolSourcesPanel from './ToolSourcesPanel.vue'
import { ref } from 'vue'
const open = defineModel<boolean>({ required: true })
const busy = ref(false)
defineEmits<{ changed: [] }>()
const { tr } = usePreferences()
</script>
<template>
  <el-dialog
    v-model="open"
    :title="tr('工具来源管理', 'Tool source management')"
    width="min(1000px,96vw)"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    destroy-on-close
  >
    <ToolSourcesPanel @changed="$emit('changed')" @busy="busy = $event" />
  </el-dialog>
</template>
