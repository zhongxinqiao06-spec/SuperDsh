<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CapabilityChoice, JsonSchema } from '@/types/tools/tools'
import { resolveSchema, schemaObject } from '@/utils/tools/schema'
import { usePreferences } from '@/store/modules/preferences'
defineOptions({ name: 'SchemaField' })
const props = withDefaults(
  defineProps<{
    schema: JsonSchema
    root: JsonSchema
    modelValue: unknown
    path: string
    required?: boolean
    configuredSecrets?: string[]
    capabilities?: CapabilityChoice[]
    depth?: number
  }>(),
  {
    required: false,
    configuredSecrets: () => [],
    capabilities: () => [],
    depth: 0,
  },
)
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>(),
  { tr } = usePreferences()
const field = computed(() => resolveSchema(props.schema, props.root)),
  object = computed(() => schemaObject(props.modelValue)),
  array = computed(() =>
    Array.isArray(props.modelValue) ? (props.modelValue as unknown[]) : [],
  ),
  additionalName = ref('')
const type = computed(() =>
  Array.isArray(field.value.type)
    ? field.value.type.find((value) => value !== 'null')
    : field.value.type,
)
const configured = computed(() => props.configuredSecrets.includes(props.path))
function change(value: unknown) {
  emit('update:modelValue', value)
}
function selectEnum(index: unknown) {
  change(typeof index === 'number' ? field.value.enum?.[index] : undefined)
}
function property(key: string, value: unknown) {
  const next = { ...object.value }
  if (value === undefined) delete next[key]
  else next[key] = value
  change(next)
}
function item(index: number, value: unknown) {
  const next = [...array.value]
  next[index] = value
  change(next)
}
function addItem() {
  const schema = field.value.items ?? {}
  change([
    ...array.value,
    schema.default ??
      (schema.type === 'object'
        ? {}
        : schema.type === 'boolean'
          ? false
          : schema.type === 'integer' || schema.type === 'number'
            ? 0
            : ''),
  ])
}
function addProperty() {
  if (
    additionalName.value.trim() &&
    !Object.hasOwn(object.value, additionalName.value.trim())
  )
    property(additionalName.value.trim(), '')
  additionalName.value = ''
}
const additionalSchema = computed(() =>
  typeof field.value.additionalProperties === 'object'
    ? field.value.additionalProperties
    : { type: 'string' },
)
const properties = computed(() => ({
  ...field.value.properties,
  ...Object.fromEntries(
    Object.keys(object.value)
      .filter((key) => !field.value.properties?.[key])
      .map((key) => [key, additionalSchema.value]),
  ),
}))
</script>
<template>
  <div v-if="depth <= 16" class="schema-field stack">
    <span v-if="field.title || path" class="field-label"
      >{{ field.title || path.split('.').at(-1)
      }}<span
        v-if="required && !(field.writeOnly && configured)"
        aria-label="required"
      >
        *</span
      ></span
    >
    <el-select
      v-if="field['x-superdsh-capability']"
      :model-value="String(modelValue ?? '')"
      clearable
      :placeholder="
        tr('新会话使用全局默认', 'Use global default for new sessions')
      "
      @update:model-value="change($event || undefined)"
      ><el-option
        v-for="choice in capabilities.filter(
          (value) => value.capability === field['x-superdsh-capability'],
        )"
        :key="choice.id"
        :value="choice.id"
        :label="`${choice.name} · ${choice.modelId}`"
    /></el-select>
    <el-select
      v-else-if="field.enum"
      :model-value="
        field.enum.findIndex((value) => Object.is(value, modelValue))
      "
      clearable
      :aria-label="field.title || path"
      @update:model-value="selectEnum"
      ><el-option
        v-for="(choice, index) in field.enum"
        :key="index"
        :value="index"
        :label="String(choice)"
    /></el-select>
    <el-switch
      v-else-if="type === 'boolean'"
      :model-value="modelValue === true"
      :aria-label="field.title || path"
      @update:model-value="change($event)"
    />
    <el-input-number
      v-else-if="type === 'integer' || type === 'number'"
      :model-value="typeof modelValue === 'number' ? modelValue : undefined"
      :min="field.minimum"
      :max="field.maximum"
      :step="type === 'integer' ? 1 : 0.1"
      :precision="type === 'integer' ? 0 : undefined"
      :aria-label="field.title || path"
      @update:model-value="change($event)"
    />
    <template v-else-if="type === 'object' || field.properties"
      ><fieldset class="schema-object">
        <SchemaField
          v-for="(child, key) in properties"
          :key="key"
          :schema="child"
          :root="root"
          :model-value="object[key]"
          :path="path ? `${path}.${key}` : String(key)"
          :required="field.required?.includes(String(key))"
          :configured-secrets="configuredSecrets"
          :capabilities="capabilities"
          :depth="depth + 1"
          @update:model-value="property(String(key), $event)"
        />
        <div v-if="field.additionalProperties !== false" class="toolbar">
          <el-input
            v-model="additionalName"
            :placeholder="tr('附加字段名称', 'Additional field name')"
          /><el-button @click="addProperty">{{
            tr('添加字段', 'Add field')
          }}</el-button>
        </div>
      </fieldset></template
    >
    <template v-else-if="type === 'array'"
      ><div
        v-for="(value, index) in array"
        :key="index"
        class="schema-array-item"
      >
        <SchemaField
          :schema="field.items ?? { type: 'string' }"
          :root="root"
          :model-value="value"
          :path="`${path}[${index}]`"
          :configured-secrets="configuredSecrets"
          :capabilities="capabilities"
          :depth="depth + 1"
          @update:model-value="item(index, $event)"
        /><el-button
          type="danger"
          plain
          @click="change(array.filter((_, entry) => entry !== index))"
          >{{ tr('移除', 'Remove') }}</el-button
        >
      </div>
      <el-button
        :disabled="
          field.maxItems !== undefined && array.length >= field.maxItems
        "
        @click="addItem"
        >{{ tr('添加条目', 'Add item') }}</el-button
      ></template
    >
    <el-input
      v-else
      :model-value="
        modelValue === undefined || modelValue === null
          ? ''
          : String(modelValue)
      "
      :type="field.writeOnly ? 'password' : 'text'"
      :show-password="field.writeOnly"
      :autocomplete="field.writeOnly ? 'new-password' : 'off'"
      :maxlength="field.maxLength"
      :minlength="field.minLength"
      :aria-label="field.title || path"
      :placeholder="
        field.writeOnly && configured
          ? tr('已配置，留空保留', 'Configured; leave blank to keep')
          : ''
      "
      @update:model-value="change($event === '' ? undefined : $event)"
    />
    <p v-if="field.description" class="muted">{{ field.description }}</p>
    <el-button
      v-if="field.writeOnly && configured"
      link
      type="danger"
      @click="change('')"
      >{{ tr('清除已保存凭据', 'Clear saved credential') }}</el-button
    ><el-tag v-if="field.writeOnly && modelValue === ''" type="warning">{{
      tr('保存时清除', 'Will clear on save')
    }}</el-tag>
  </div>
  <el-alert
    v-else
    :title="tr('配置层级过深，请简化Schema', 'Schema nesting is too deep')"
    type="error"
  />
</template>
<style scoped>
.schema-field {
  gap: 8px;
}
.schema-object {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 14px;
  display: grid;
  gap: 16px;
  min-width: 0;
}
.schema-array-item {
  display: flex;
  gap: 12px;
  align-items: start;
}
.schema-array-item > .schema-field {
  flex: 1;
  min-width: 0;
}
.field-label {
  font-weight: 500;
}
.muted {
  margin: 0;
  font-size: 12px;
}
</style>
