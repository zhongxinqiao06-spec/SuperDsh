<script setup lang="ts">
import ExpandableText from '@/components/base/ExpandableText.vue'

/** 复选组中的长内容选项：标签负责选择，说明独立展开，不把正文塞进单行控件。 */
defineProps<{
  value: string
  title: string
  description?: string
  disabled?: boolean
}>()
</script>

<template>
  <div class="selection-option">
    <el-checkbox :value="value" :disabled="disabled" :aria-label="title">{{
      title
    }}</el-checkbox>
    <ExpandableText
      v-if="description"
      :text="description"
      :lines="2"
      label="内容"
    />
  </div>
</template>

<style scoped>
.selection-option {
  min-width: 0;
  display: grid;
  gap: var(--label-gap);
  /* Element 复选组以零字号消除行内间隙，正文必须恢复正常字号。 */
  font-size: var(--font-size-body);
}
.selection-option > .expandable-text {
  padding-inline-start: 24px;
}
</style>
