<script setup lang="ts">
import { useWorkbench } from '@/composables/workbench/use-workbench'
import OfficeComposer from '@/views/workbench/components/OfficeComposer.vue'
/** 首页仅在用户具有工作台权限时装配；浏览首页不会启动服务端 Agent。 */
const workspace = useWorkbench('home')
</script>
<template>
  <el-alert
    v-if="workspace.error.value || workspace.runtime.error"
    :title="workspace.error.value || workspace.runtime.error"
    type="error"
    :closable="false"
  />
  <OfficeComposer :workspace="workspace" home />
</template>
