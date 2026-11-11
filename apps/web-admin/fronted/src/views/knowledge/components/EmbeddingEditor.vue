<script setup lang="ts">
import type {
  EmbeddingDraft,
  EmbeddingSettings,
} from '@/types/knowledge/knowledge'
/** 明确模型切换与资料外发条件，密钥保留语义和普通模型保持一致。 */
const props = defineProps<{
  draft: EmbeddingDraft
  settings: EmbeddingSettings | null
  busy: boolean
}>()
const emit = defineEmits<{
  prepare: []
  'update:draft': [value: EmbeddingDraft]
}>()
/** 只发布新草稿，由父级用例保存；不修改传入对象及其嵌套字段。 */
function patch(value: Partial<EmbeddingDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
</script>

<template>
  <el-alert
    type="info"
    title="保存会先验证新模型并为全部资料建立新索引；失败保留当前模型和索引。"
    :closable="false"
  />
  <label
    >语义模型类型<el-select
      :model-value="draft.kind"
      @update:model-value="patch({ kind: $event })"
      ><el-option value="local" label="本地语义模型" /><el-option
        value="openai-compatible"
        label="OpenAI 兼容 Embedding" /></el-select
  ></label>
  <template v-if="draft.kind === 'local'"
    ><p>
      固定模型：{{ settings?.localDefault.model }} ·
      {{ settings?.localDefault.dimensions }} 维
    </p>
    <el-button :loading="busy" @click="$emit('prepare')"
      >准备本地模型文件</el-button
    ></template
  >
  <template v-else
    ><el-alert
      type="warning"
      title="资料正文将发送给该供应商；地址必须已被部署维护者加入资料外发信任列表。"
      :closable="false"
    /><label
      >API 地址<el-input
        :model-value="draft.baseUrl"
        @update:model-value="patch({ baseUrl: $event })" /></label
    ><label
      >模型 ID<el-input
        :model-value="draft.model"
        maxlength="200"
        @update:model-value="patch({ model: $event })" /></label
    ><label
      >模型修订标识<el-input
        :model-value="draft.revision"
        maxlength="100"
        placeholder="填写供应商模型实际修订，改变后将重建索引"
        @update:model-value="patch({ revision: $event })" /></label
    ><label
      >向量维度<el-input-number
        :model-value="draft.dimensions"
        :min="1"
        :max="4096"
        @update:model-value="
          patch({ dimensions: $event ?? draft.dimensions })
        " /></label
    ><label
      >API Key<el-input
        :model-value="draft.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        :placeholder="
          settings?.profile.apiKeyConfigured
            ? '已配置，留空保留'
            : '输入供应商密钥'
        "
        @update:model-value="patch({ apiKey: $event })" /></label
    ><el-checkbox
      :model-value="draft.clearApiKey"
      :disabled="Boolean(draft.apiKey)"
      @update:model-value="patch({ clearApiKey: Boolean($event) })"
      >明确清除已有密钥</el-checkbox
    ></template
  >
</template>
