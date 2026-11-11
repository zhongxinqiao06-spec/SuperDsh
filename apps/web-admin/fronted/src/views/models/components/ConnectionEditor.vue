<script setup lang="ts">
import type { ConnectionDraft } from '@/types/models/models'
/** 连接编辑不会把旧密钥写进输入框，复用连接的能力类型由服务端约束。 */
const props = defineProps<{ draft: ConnectionDraft; keyConfigured: boolean }>()
const emit = defineEmits<{ 'update:draft': [value: ConnectionDraft] }>()
/** 只发布新草稿，由父级用例保存；不修改传入对象及其嵌套字段。 */
function patch(value: Partial<ConnectionDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
</script>

<template>
  <label
    >连接名称<el-input
      :model-value="draft.name"
      maxlength="100"
      @update:model-value="patch({ name: $event })"
  /></label>
  <label
    >适配器<el-select
      :model-value="draft.adapter"
      @update:model-value="patch({ adapter: $event })"
      ><el-option
        value="openai-completions"
        label="OpenAI Chat Completions" /><el-option
        value="openai-responses"
        label="OpenAI Responses" /><el-option
        value="anthropic-messages"
        label="Anthropic Messages" /><el-option
        value="volcengine-ark"
        label="火山方舟" /><el-option
        value="volcengine-speech"
        label="火山语音（能力尚未开放）" /></el-select
  ></label>
  <label
    >API 地址<el-input
      :model-value="draft.baseUrl"
      placeholder="供应商提供的完整 Base URL"
      @update:model-value="patch({ baseUrl: $event })"
  /></label>
  <label
    >区域（可选）<el-input
      :model-value="draft.region"
      maxlength="100"
      @update:model-value="patch({ region: $event })"
  /></label>
  <label
    >API Key<el-input
      :model-value="draft.apiKey"
      type="password"
      show-password
      autocomplete="new-password"
      :placeholder="keyConfigured ? '已配置，留空保留' : '输入供应商密钥'"
      @update:model-value="patch({ apiKey: $event })"
  /></label>
  <el-checkbox
    v-if="keyConfigured"
    :model-value="draft.clearApiKey"
    :disabled="Boolean(draft.apiKey)"
    @update:model-value="patch({ clearApiKey: Boolean($event) })"
    >明确清除已有密钥</el-checkbox
  >
  <el-checkbox
    :model-value="draft.enabled"
    @update:model-value="patch({ enabled: Boolean($event) })"
    >启用连接</el-checkbox
  >
</template>
