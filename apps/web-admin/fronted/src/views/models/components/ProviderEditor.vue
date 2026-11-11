<script setup lang="ts">
import { computed, watch } from 'vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import type { ModelDefinition, ProviderDraft } from '@/types/models/models'
import type { ProviderPreset } from '@/utils/models/provider-presets'
/** 供应商字段与模型列表分开编辑，密钥空值保留由服务端解释。 */
const props = defineProps<{
  draft: ProviderDraft
  keyConfigured: boolean
  creating?: boolean
  preset?: ProviderPreset
  makeDefault?: boolean
  page?: number
  pageSize?: number
}>()
const emit = defineEmits<{
  'update:draft': [value: ProviderDraft]
  'update:preset': [value: ProviderPreset]
  'update:makeDefault': [value: boolean]
  'update:page': [value: number]
  'update:pageSize': [value: number]
}>()
const page = computed({
  get: () => props.page ?? 1,
  set: (value) => emit('update:page', value),
})
const pageSize = computed({
  get: () => props.pageSize ?? 10,
  set: (value) => {
    emit('update:pageSize', value)
    emit('update:page', 1)
  },
})
const models = computed(() =>
  props.draft.models
    .map((model, index) => ({ model, index }))
    .slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
)
watch(
  () => props.draft.models.length,
  (count) => {
    if (page.value > Math.max(1, Math.ceil(count / pageSize.value)))
      page.value = Math.max(1, Math.ceil(count / pageSize.value))
  },
)
/** 只发布新草稿，由父级用例保存；不修改传入对象及其嵌套字段。 */
function patch(value: Partial<ProviderDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
/** 模型行和能力数组始终生成副本，避免子组件改动父级草稿。 */
function patchModel(index: number, value: Partial<ModelDefinition>): void {
  patch({
    models: props.draft.models.map((model, position) =>
      position === index ? { ...model, ...value } : model,
    ),
  })
}
function setInputTypes(index: number, values: unknown): void {
  if (!Array.isArray(values)) return
  patchModel(index, {
    inputTypes: values.filter(
      (value): value is 'text' | 'image' =>
        value === 'text' || value === 'image',
    ),
  })
}
function removeModel(index: number): void {
  if (props.draft.models.length > 1)
    patch({
      models: props.draft.models.filter((_, position) => position !== index),
    })
}
function addModel(): void {
  if (props.draft.models.length < 100)
    patch({
      models: [
        ...props.draft.models,
        {
          modelId: '',
          name: '',
          contextWindow: null,
          maxTokens: null,
          inputTypes: ['text'],
        },
      ],
    })
}
</script>

<template>
  <div v-if="creating" class="stack">
    <label
      >供应商<el-select
        :model-value="preset ?? 'deepseek'"
        @update:model-value="emit('update:preset', $event)"
        ><el-option label="DeepSeek" value="deepseek" /><el-option
          label="自定义"
          value="custom" /></el-select
    ></label>
    <small v-if="preset !== 'custom'"
      >已填入官方接口和模型，只需填写 API Key
      后保存。其他参数可以按需调整。</small
    >
  </div>
  <div class="provider-editor-fields">
    <label
      >供应商名称<el-input
        :model-value="draft.name"
        maxlength="100"
        required
        @update:model-value="patch({ name: $event })"
    /></label>
    <label
      >协议<el-select
        :model-value="draft.protocol"
        @update:model-value="patch({ protocol: $event })"
        ><el-option
          value="openai-completions"
          label="OpenAI Chat Completions" /><el-option
          value="openai-responses"
          label="OpenAI Responses" /><el-option
          value="anthropic-messages"
          label="Anthropic Messages" /></el-select
    ></label>
    <label
      >API 地址<el-input
        :model-value="draft.baseUrl"
        type="url"
        required
        placeholder="供应商提供的完整 Base URL"
        @update:model-value="patch({ baseUrl: $event })"
    /></label>
    <label
      >API Key<el-input
        :model-value="draft.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        :required="creating && preset !== 'custom'"
        :disabled="draft.clearApiKey"
        :placeholder="keyConfigured ? '已配置，留空保留' : '输入供应商密钥'"
        @update:model-value="patch({ apiKey: $event })"
    /></label>
  </div>
  <div class="provider-editor-options">
    <el-checkbox
      v-if="keyConfigured"
      :model-value="draft.clearApiKey"
      @update:model-value="patch({ clearApiKey: Boolean($event), apiKey: '' })"
      >明确清除已有密钥</el-checkbox
    >
    <el-checkbox
      :model-value="draft.enabled"
      @update:model-value="patch({ enabled: Boolean($event) })"
      >启用供应商</el-checkbox
    >
    <el-checkbox
      v-if="creating || makeDefault"
      :model-value="makeDefault"
      :disabled="!draft.enabled"
      @update:model-value="emit('update:makeDefault', Boolean($event))"
      >设为默认模型<span v-if="makeDefault">
        · {{ draft.models[0]?.name || draft.models[0]?.modelId }}</span
      ></el-checkbox
    >
  </div>
  <h3>模型列表</h3>
  <fieldset
    v-for="{ model, index } in models"
    :key="index"
    class="provider-model-fields"
  >
    <legend>模型 {{ index + 1 }}</legend>
    <label
      >模型 ID<el-input
        :model-value="model.modelId"
        maxlength="200"
        required
        @update:model-value="patchModel(index, { modelId: $event })"
    /></label>
    <label
      >显示名称<el-input
        :model-value="model.name"
        maxlength="200"
        @update:model-value="patchModel(index, { name: $event })"
    /></label>
    <label
      >上下文 Token<el-input-number
        :model-value="model.contextWindow"
        :min="1"
        @update:model-value="
          patchModel(index, { contextWindow: $event ?? null })
        "
    /></label>
    <label
      >最大输出 Token<el-input-number
        :model-value="model.maxTokens"
        :min="1"
        @update:model-value="patchModel(index, { maxTokens: $event ?? null })"
    /></label>
    <el-checkbox-group
      :model-value="model.inputTypes"
      @update:model-value="setInputTypes(index, $event)"
      ><el-checkbox value="text">文本</el-checkbox
      ><el-checkbox value="image">图片</el-checkbox></el-checkbox-group
    >
    <el-button
      type="danger"
      plain
      :disabled="draft.models.length === 1"
      @click="removeModel(index)"
      >移除模型</el-button
    >
  </fieldset>
  <ManagementPagination
    v-if="draft.models.length > 10"
    v-model:current-page="page"
    v-model:page-size="pageSize"
    :total="draft.models.length"
    :page-sizes="[10, 20, 50]"
  />
  <el-button :disabled="draft.models.length >= 100" @click="addModel"
    >添加模型</el-button
  >
</template>

<style scoped>
.provider-editor-fields,
.provider-model-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
}
.provider-editor-fields label,
.provider-model-fields label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.provider-editor-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.provider-model-fields {
  padding: 12px;
  border: 0;
  border-radius: 8px;
  background: var(--muted);
}
.provider-model-fields .el-input-number {
  width: 100%;
}
small {
  color: var(--muted-foreground);
}
h3 {
  margin: 0;
  font-size: 16px;
}
@media (max-width: 640px) {
  .provider-editor-fields,
  .provider-model-fields {
    grid-template-columns: 1fr;
  }
}
</style>
