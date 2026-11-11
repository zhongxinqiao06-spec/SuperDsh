<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RuntimeSchema, RuntimeUi } from '@/types/devices/devices'
/** 按设备声明的 Schema 渲染配置字段，嵌套更新通过 emit 返回独立对象。 */
const props = defineProps<{
  schema: RuntimeSchema
  modelValue: Record<string, unknown>
  ui?: RuntimeUi
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
}>()
const parseErrors = ref<Record<string, string>>({})
const rawInputs = ref<Record<string, string>>({})
const fields = computed(() => Object.entries(props.schema.properties ?? {}))
const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const fieldUi = (key: string) => objectValue(props.ui?.[key])
function set(key: string, value: unknown): void {
  const copy = { ...props.modelValue }
  if (value === undefined) delete copy[key]
  else copy[key] = value
  emit('update:modelValue', copy)
}
function setJson(key: string, value: string, schema: RuntimeSchema): void {
  rawInputs.value[key] = value
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      (schema.type === 'array' && !Array.isArray(parsed)) ||
      (schema.type === 'object' &&
        (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
    )
      throw new Error('类型不符')
    delete parseErrors.value[key]
    set(key, parsed)
  } catch {
    parseErrors.value[key] =
      `请输入有效的${schema.type === 'array' ? '数组' : '对象'}`
    set(key, value)
  }
}
function displayed(key: string, schema: RuntimeSchema): unknown {
  return props.modelValue[key] ?? schema.default
}
</script>
<template>
  <div class="runtime-fields">
    <label v-for="[key, field] in fields" :key="key" class="runtime-field"
      ><span
        >{{ field.title || key }}
        <b v-if="schema.required?.includes(key)">*</b></span
      ><small v-if="field.description">{{ field.description }}</small>
      <RuntimeFields
        v-if="field.type === 'object' && field.properties"
        :schema="field"
        :model-value="objectValue(modelValue[key])"
        :ui="objectValue(ui?.[key])"
        :disabled="disabled"
        @update:model-value="set(key, $event)"
      />
      <el-select
        v-else-if="field.enum"
        :model-value="displayed(key, field)"
        :disabled="disabled"
        clearable
        @update:model-value="set(key, $event)"
        ><el-option
          v-for="(option, index) in field.enum"
          :key="index"
          :value="option"
          :label="String(option)"
      /></el-select>
      <el-switch
        v-else-if="field.type === 'boolean'"
        :model-value="Boolean(displayed(key, field))"
        :disabled="disabled"
        @update:model-value="set(key, $event)"
      />
      <el-input-number
        v-else-if="field.type === 'integer' || field.type === 'number'"
        :model-value="
          typeof displayed(key, field) === 'number'
            ? Number(displayed(key, field))
            : undefined
        "
        :min="field.minimum"
        :max="field.maximum"
        :precision="field.type === 'integer' ? 0 : undefined"
        :disabled="disabled"
        @update:model-value="set(key, $event)"
      />
      <template v-else-if="field.type === 'array' || field.type === 'object'"
        ><el-input
          type="textarea"
          :rows="3"
          :model-value="
            rawInputs[key] ??
            JSON.stringify(
              displayed(key, field) ?? (field.type === 'array' ? [] : {}),
              null,
              2,
            )
          "
          :disabled="disabled"
          @input="setJson(key, $event, field)"
        /><span v-if="parseErrors[key]" role="alert">{{
          parseErrors[key]
        }}</span></template
      >
      <el-input
        v-else
        :model-value="String(displayed(key, field) ?? '')"
        :type="
          field.format === 'password' || fieldUi(key).component === 'password'
            ? 'password'
            : fieldUi(key).component === 'textarea'
              ? 'textarea'
              : 'text'
        "
        :show-password="
          field.format === 'password' || fieldUi(key).component === 'password'
        "
        :maxlength="field.maxLength"
        :disabled="disabled"
        autocomplete="off"
        @update:model-value="set(key, $event)"
      />
    </label>
    <p v-if="!fields.length">此运行类型没有需要填写的配置项。</p>
  </div>
</template>
<style scoped>
.runtime-fields {
  display: grid;
  gap: 16px;
}
.runtime-field {
  display: grid;
  gap: 6px;
}
.runtime-field > .runtime-fields {
  padding-left: 14px;
  border-left: 2px solid var(--el-border-color);
}
small {
  color: var(--el-text-color-secondary);
}
b,
[role='alert'] {
  color: var(--el-color-danger);
}
</style>
