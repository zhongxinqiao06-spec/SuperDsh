<script setup lang="ts">
import type { ConnectionDraft } from '@/types/storage/storage'
/** S3 连接表单仅编辑领域字段，已有凭据空白保留。 */
const props = defineProps<{ draft: ConnectionDraft; existing: boolean }>()
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
    >服务地址<el-input
      :model-value="draft.endpoint"
      placeholder="https://对象存储服务地址"
      @update:model-value="patch({ endpoint: $event })"
  /></label>
  <label
    >存储桶<el-input
      :model-value="draft.bucket"
      @update:model-value="patch({ bucket: $event })"
  /></label>
  <div class="form-grid">
    <label
      >区域<el-input
        :model-value="draft.region"
        @update:model-value="patch({ region: $event })" /></label
    ><label
      >对象前缀<el-input
        :model-value="draft.prefix"
        @update:model-value="patch({ prefix: $event })"
    /></label>
  </div>
  <el-checkbox
    :model-value="draft.virtualHostStyle"
    @update:model-value="patch({ virtualHostStyle: Boolean($event) })"
    >使用虚拟主机寻址</el-checkbox
  ><el-checkbox
    :model-value="draft.enabled"
    @update:model-value="patch({ enabled: Boolean($event) })"
    >启用连接</el-checkbox
  >
  <p v-if="existing" class="muted">访问密钥与秘密密钥都留空时保留原有凭据。</p>
  <label
    >访问密钥<el-input
      :model-value="draft.accessKeyId"
      autocomplete="off"
      @update:model-value="patch({ accessKeyId: $event })"
  /></label>
  <label
    >秘密密钥<el-input
      :model-value="draft.secretAccessKey"
      type="password"
      show-password
      autocomplete="new-password"
      @update:model-value="patch({ secretAccessKey: $event })"
  /></label>
  <label
    >会话令牌（可选）<el-input
      :model-value="draft.sessionToken"
      type="password"
      show-password
      autocomplete="new-password"
      @update:model-value="patch({ sessionToken: $event })"
  /></label>
</template>
<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
