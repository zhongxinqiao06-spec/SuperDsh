<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import type { useRuntimeSelections } from '@/composables/workbench/use-runtime-selections'
import AppIcon from '@/components/base/AppIcon.vue'
import RuntimeSelectorFields from './RuntimeSelectorFields.vue'

/** 按输入卡实际宽度折叠设置；抽屉复用选择状态，侧栏伸缩不会挤掉权限入口。 */
defineProps<{
  selection: ReturnType<typeof useRuntimeSelections>
  disabled?: boolean
  existing: boolean
}>()
const root = ref<HTMLElement | null>(null)
const compact = ref(false),
  opened = ref(false)
let resize: ResizeObserver | null = null
onMounted(() => {
  const composer = root.value?.closest('.composer')
  if (!composer) return
  resize = new ResizeObserver(([entry]) => {
    compact.value = !!entry && entry.contentRect.width < 600
    if (!compact.value) opened.value = false
  })
  resize.observe(composer)
})
onScopeDispose(() => resize?.disconnect())
</script>

<template>
  <div ref="root" class="runtime-selector-control">
    <RuntimeSelectorFields
      v-if="!compact"
      :selection="selection"
      :existing="existing"
      :disabled="disabled"
    />
    <template v-else>
      <el-button
        class="runtime-settings-trigger"
        :disabled="disabled"
        aria-label="模型与权限设置"
        @click="opened = true"
        ><AppIcon name="settings" />设置</el-button
      >
      <el-drawer
        v-model="opened"
        title="模型与权限设置"
        direction="btt"
        size="auto"
        class="runtime-settings-drawer"
        append-to-body
      >
        <RuntimeSelectorFields
          :selection="selection"
          :existing="existing"
          :disabled="disabled"
        />
      </el-drawer>
    </template>
  </div>
</template>

<style>
.runtime-selector-control {
  display: contents;
}
.runtime-settings-trigger .app-icon {
  margin-right: 4px;
}
.runtime-settings-drawer {
  border-radius: 20px 20px 0 0;
}
.runtime-settings-drawer .runtime-selectors {
  display: grid;
  gap: 16px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.runtime-settings-drawer .runtime-selectors .el-select {
  width: 100%;
}
</style>
