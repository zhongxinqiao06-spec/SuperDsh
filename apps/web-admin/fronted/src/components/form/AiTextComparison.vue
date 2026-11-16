<script setup lang="ts">
/** 通用文本建议对比：只展示和编辑候选，采用及持久化由调用方控制。 */
defineProps<{
  original: string
  disabled?: boolean
  conflict?: string | null
}>()
const suggestion = defineModel<string>({ required: true })
</script>
<template>
  <section class="ai-text-comparison" aria-label="修改前后对比">
    <div class="field">
      <strong>修改前</strong>
      <div class="ai-original" tabindex="0">{{ original }}</div>
    </div>
    <label class="field"
      >修改建议 · 可以继续编辑<el-input
        v-model="suggestion"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 16 }"
        :disabled="disabled"
        maxlength="12000"
        aria-label="修改建议"
    /></label>
    <el-alert
      v-if="conflict"
      :title="conflict"
      type="warning"
      :closable="false"
    />
  </section>
</template>
<style scoped>
.ai-text-comparison {
  display: grid;
  gap: var(--field-gap);
}
.ai-original {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  max-height: 32vh;
  overflow: auto;
  padding: var(--field-gap);
  background: var(--muted);
  border-radius: var(--radius);
}
</style>
