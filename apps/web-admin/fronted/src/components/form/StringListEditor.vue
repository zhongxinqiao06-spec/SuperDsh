<script setup lang="ts">
import { useId } from 'vue'
/** 字符串列表逐项编辑；保留空行草稿，规范化交由保存边界处理。 */
const props = defineProps<{
  modelValue: string[]
  label: string
  placeholder?: string
  disabled?: boolean
  maxlength?: number
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const id = useId()
function update(index: number, value: string): void {
  emit(
    'update:modelValue',
    props.modelValue.map((item, position) =>
      position === index ? value : item,
    ),
  )
}
function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, position) => position !== index),
  )
}
</script>
<template>
  <fieldset class="string-list-editor" :disabled="disabled">
    <legend>{{ label }}</legend>
    <div
      v-for="(item, index) in modelValue"
      :key="`${id}-${index}`"
      class="string-list-row"
    >
      <span class="string-list-index">{{ index + 1 }}</span>
      <el-input
        :model-value="item"
        :aria-label="`${label} ${index + 1}`"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 5 }"
        :maxlength="maxlength"
        :placeholder="placeholder"
        :disabled="disabled"
        @update:model-value="update(index, $event)"
      />
      <el-button
        text
        size="small"
        :disabled="disabled"
        :aria-label="`删除${label} ${index + 1}`"
        @click="remove(index)"
        >移除</el-button
      >
    </div>
    <p v-if="!modelValue.length" class="muted">暂无内容，可按需添加。</p>
    <el-button
      text
      :disabled="disabled"
      @click="emit('update:modelValue', [...modelValue, ''])"
      >＋ 添加一项</el-button
    >
  </fieldset>
</template>
