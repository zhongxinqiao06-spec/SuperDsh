<script setup lang="ts">
import { computed } from 'vue'
/** 面向用户以秒编辑，契约继续使用整数毫秒；空值保留继承语义。 */
const props = defineProps<{
  modelValue: number | null | undefined
  label: string
  disabled?: boolean
  min?: number
  max?: number
  placeholder?: number
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()
const seconds = computed(() =>
  props.modelValue == null ? '' : props.modelValue / 1000,
)
function update(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value === '') emit('update:modelValue', null)
  else if (Number.isFinite(Number(value)))
    emit('update:modelValue', Math.round(Number(value) * 1000))
}
</script>
<template>
  <label class="field"
    >{{ label }}（秒）<input
      class="native-control"
      type="number"
      step="0.001"
      :value="seconds"
      :min="min == null ? undefined : min / 1000"
      :max="max == null ? undefined : max / 1000"
      :placeholder="
        placeholder == null ? undefined : String(placeholder / 1000)
      "
      :disabled="disabled"
      @input="update"
  /></label>
</template>
