<script setup lang="ts">
/** 公共编辑抽屉：固定标题与操作区，正文单独滚动；关闭时保留领域草稿。 */
withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    size?: string
  }>(),
  { size: 'min(560px, 100vw)' },
)
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    :size="size"
    class="app-drawer"
    :destroy-on-close="false"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <slot />
    <template v-if="$slots.footer" #footer>
      <div class="app-drawer-actions"><slot name="footer" /></div>
    </template>
  </el-drawer>
</template>

<style>
.app-drawer .el-drawer__header {
  flex-shrink: 0;
  padding: var(--field-gap) var(--panel-padding);
}
.app-drawer .el-drawer__body {
  min-width: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scroll-padding-block: var(--field-gap);
}
.app-drawer .el-drawer__footer {
  flex-shrink: 0;
  padding-bottom: max(var(--field-gap), env(safe-area-inset-bottom));
  text-align: start;
  background: var(--popover);
}
.app-drawer-actions {
  display: grid;
  min-width: 0;
  gap: var(--control-gap);
}
.app-drawer-actions > p {
  margin: 0;
  overflow-wrap: anywhere;
}
.app-drawer-actions .el-alert {
  margin: 0;
  overflow-wrap: anywhere;
}
/* 操作区属于抽屉布局，不覆盖正文；长按钮在手机上完整换行且保留触控高度。 */
@media (max-width: 600px) {
  .app-drawer-actions .dialog-actions > .el-button {
    flex: 1 1 auto;
    min-height: 44px;
    height: auto;
    max-width: 100%;
    padding-block: var(--control-gap);
    white-space: normal;
  }
  .app-drawer-actions .el-button > span {
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
}
</style>
