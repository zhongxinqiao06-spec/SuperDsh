<script setup lang="ts">
import { computed } from 'vue'
import type {
  ConfigurationDraft,
  ModelCatalog,
  ParameterSchema,
} from '@/types/models/models'
/** 模型参数按能力 Schema 渲染，保持字段校验而非 JSON 文本框。 */
const props = defineProps<{
  draft: ConfigurationDraft
  catalog: ModelCatalog | null
  editing: boolean
  multimodal: boolean
  roles: { id: string; name: string }[]
}>()
const selected = computed(() =>
  props.catalog?.capabilities.find(
    (item) => item.id === props.draft.capability,
  ),
)
const adapter = computed(
  () =>
    props.catalog?.connections.find(
      (item) => item.id === props.draft.connectionId,
    )?.adapter,
)
const parameters = computed(() =>
  Object.entries(selected.value?.configurationSchema.properties ?? {}).filter(
    ([, schema]) =>
      !schema['x-superdsh-adapters'] ||
      (adapter.value && schema['x-superdsh-adapters'].includes(adapter.value)),
  ),
)
function text(key: string, schema: ParameterSchema): string {
  const value = props.draft.parameters[key] ?? schema.default
  return typeof value === 'string' ? value : ''
}
function number(key: string, schema: ParameterSchema): number | undefined {
  const value = props.draft.parameters[key] ?? schema.default
  return typeof value === 'number' ? value : undefined
}
function setNumber(key: string, value: number | undefined): void {
  const parameters = { ...props.draft.parameters }
  if (value === undefined) delete parameters[key]
  else parameters[key] = value
  patch({ parameters })
}
const emit = defineEmits<{ 'update:draft': [value: ConfigurationDraft] }>()
/** 只发布新草稿，由父级用例保存；不修改传入对象及其嵌套字段。 */
function patch(value: Partial<ConfigurationDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
</script>

<template>
  <label
    >配置名称<el-input
      :model-value="draft.name"
      maxlength="100"
      @update:model-value="patch({ name: $event })"
  /></label>
  <label
    >供应商连接<el-select
      :model-value="draft.connectionId"
      :disabled="editing"
      @update:model-value="patch({ connectionId: $event })"
      ><el-option
        v-for="connection in catalog?.connections ?? []"
        :key="connection.id"
        :value="connection.id"
        :label="
          connection.name + (connection.enabled ? '' : '（停用）')
        " /></el-select
  ></label>
  <label
    >能力<el-select
      :model-value="draft.capability"
      :disabled="editing"
      @update:model-value="patch({ capability: $event, parameters: {} })"
      ><el-option
        v-for="capability in catalog?.capabilities.filter((item) =>
          multimodal ? item.id !== 'chat' : item.id === 'chat',
        ) ?? []"
        :key="capability.id"
        :value="capability.id"
        :label="capability.name + (capability.available ? '' : '（尚未开放）')"
        :disabled="!capability.available" /></el-select
  ></label>
  <label
    >模型 ID<el-input
      :model-value="draft.modelId"
      maxlength="200"
      @update:model-value="patch({ modelId: $event })"
  /></label>
  <label v-for="[key, schema] in parameters" :key="key"
    >{{ schema.title ?? key }}
    <el-input-number
      v-if="schema.type === 'integer'"
      :model-value="number(key, schema)"
      :min="schema.minimum"
      :max="schema.maximum"
      @update:model-value="setNumber(key, $event)"
    />
    <el-select
      v-else-if="schema.enum"
      :model-value="text(key, schema)"
      @update:model-value="
        patch({ parameters: { ...draft.parameters, [key]: String($event) } })
      "
      ><el-option
        v-for="value in schema.enum"
        :key="value"
        :value="value"
        :label="value"
    /></el-select>
    <el-input
      v-else
      :model-value="text(key, schema)"
      @update:model-value="
        patch({ parameters: { ...draft.parameters, [key]: $event } })
      "
    />
  </label>
  <label
    >可用角色（不选表示所有角色）<el-select
      :model-value="draft.roleIds"
      multiple
      :disabled="!roles.length"
      @update:model-value="patch({ roleIds: $event })"
      ><el-option
        v-for="role in roles"
        :key="role.id"
        :value="role.id"
        :label="role.name" /></el-select
  ></label>
  <el-checkbox
    :model-value="draft.enabled"
    @update:model-value="patch({ enabled: Boolean($event) })"
    >启用配置</el-checkbox
  >
</template>
