<script setup lang="ts">
import { ref, useId } from 'vue'
/** 长文本随内容增长；展开编辑沿用父草稿，不产生第二份持久状态。 */
withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder?: string
    maxlength?: number
    disabled?: boolean
    minRows?: number
    maxRows?: number
    expandable?: boolean
    error?: string
  }>(),
  { minRows: 3, maxRows: 14, placeholder: '', maxlength: undefined, error: '' },
)
defineEmits<{ 'update:modelValue': [value: string] }>()
const expanded = ref(false)
const inputId = `long-text-${useId()}`
</script>
<template>
  <div class="long-text-field field">
    <div class="field-heading">
      <label :for="inputId">{{ label }}</label
      ><el-button
        v-if="expandable"
        text
        size="small"
        :disabled="disabled"
        @click="expanded = true"
        >展开编辑</el-button
      >
    </div>
    <el-input
      :id="inputId"
      :model-value="modelValue"
      :aria-invalid="Boolean(error)"
      :aria-describedby="error ? `${inputId}-error` : undefined"
      type="textarea"
      :autosize="{ minRows, maxRows }"
      :maxlength="maxlength"
      :disabled="disabled"
      :placeholder="placeholder"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <small v-if="error" :id="`${inputId}-error`" class="field-error">{{
      error
    }}</small>
    <el-dialog
      v-model="expanded"
      :title="label"
      class="long-text-dialog"
      width="min(960px, calc(100vw - 32px))"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-input
        :model-value="modelValue"
        :aria-label="label"
        type="textarea"
        :autosize="{ minRows: 12, maxRows: 24 }"
        :maxlength="maxlength"
        :disabled="disabled"
        @update:model-value="$emit('update:modelValue', $event)"
      />
      <template #footer
        ><el-button @click="expanded = false">完成编辑</el-button></template
      >
    </el-dialog>
  </div>
</template>
