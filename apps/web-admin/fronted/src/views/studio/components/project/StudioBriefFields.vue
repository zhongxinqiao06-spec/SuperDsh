<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectBrief } from '@/types/studio/foundation'
/** 新建和编辑共享规格表单；分钟秒数仅为展示，接口统一使用毫秒。 */
const model = defineModel<ProjectBrief>({ required: true })
defineProps<{ disabled?: boolean }>()
const ratio = computed({
  get: () =>
    model.value.aspectWidth && model.value.aspectHeight
      ? `${model.value.aspectWidth}:${model.value.aspectHeight}`
      : '',
  set: (value: string) => {
    const parts = value.split(':').map(Number)
    model.value.aspectWidth = parts[0] || null
    model.value.aspectHeight = parts[1] || null
  },
})
const seconds = computed({
  get: () =>
    model.value.targetDurationMs == null
      ? undefined
      : model.value.targetDurationMs / 1000,
  set: (value: number | undefined) => {
    model.value.targetDurationMs =
      value == null ? null : Math.round(value * 1000)
  },
})
</script>
<template>
  <div class="form-stack">
    <label class="field"
      >作品名称<el-input
        v-model="model.title"
        :disabled="disabled"
        maxlength="120"
        aria-label="作品名称"
    /></label>
    <label class="field"
      >故事构想<el-input
        v-model="model.brief"
        :disabled="disabled"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 12 }"
        maxlength="12000"
        placeholder="讲谁的故事、发生什么、希望观众感受到什么"
        aria-label="故事构想"
    /></label>
    <div class="brief-grid">
      <label class="field"
        >画幅<el-select
          v-model="ratio"
          :disabled="disabled"
          aria-label="画幅"
          placeholder="选择画幅"
          allow-create
          filterable
          default-first-option
          ><el-option label="竖屏 · 9:16" value="9:16" /><el-option
            label="横屏 · 16:9"
            value="16:9" /><el-option
            label="方形 · 1:1"
            value="1:1" /></el-select
      ></label>
      <label class="field"
        >目标时长（秒）<el-input-number
          v-model="seconds"
          :disabled="disabled"
          :min="1"
          :max="3600"
          :precision="0"
          aria-label="目标时长"
      /></label>
    </div>
    <label class="field"
      >视觉风格<el-input
        v-model="model.styleBrief"
        :disabled="disabled"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 10 }"
        maxlength="12000"
        placeholder="例如：写实雨夜、冷暖灯光、安静克制"
        aria-label="视觉风格"
    /></label>
    <label class="field"
      >主要语言<el-input
        v-model="model.language"
        :disabled="disabled"
        maxlength="35"
        placeholder="例如 zh-CN"
        aria-label="主要语言"
    /></label>
  </div>
</template>
<style scoped>
.brief-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--field-gap);
}
.brief-grid :deep(.el-input-number) {
  width: 100%;
}
@media (max-width: 540px) {
  .brief-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
