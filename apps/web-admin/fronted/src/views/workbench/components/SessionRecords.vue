<script setup lang="ts">
import { toRef } from 'vue'
import { useRecords } from '@/composables/workbench/use-records'
import MarkdownContent from '@/components/MarkdownContent.vue'
/** 方案编辑只提出修订，执行确认仍由原生交互卡明确完成。 */
const props = defineProps<{ sessionId: string; canWrite: boolean }>()
const records = useRecords(toRef(props, 'sessionId'))
function closeEditor(done: () => void): void {
  if (!records.saving.value) {
    records.editing.value = null
    done()
  }
}
</script>
<template>
  <section class="session-records" aria-label="方案与资料依据">
    <el-alert
      v-if="records.error.value"
      :title="records.error.value"
      type="error"
      :closable="false"
    />
    <el-alert
      v-if="records.note.value"
      :title="records.note.value"
      type="info"
      :closable="false"
    />
    <details v-for="plan in records.plans.value" :key="plan.id">
      <summary>
        {{ plan.title }} · 修订 {{ plan.version }} · {{ plan.state }}
      </summary>
      <MarkdownContent :content="plan.summary" />
      <pre>{{ JSON.stringify(plan.document, null, 2) }}</pre>
      <el-button
        v-if="canWrite && plan.state === 'prepared'"
        @click="records.edit(plan)"
        >修改方案</el-button
      >
    </details>
    <details
      v-if="
        records.sources.value.length ||
        records.verification.value?.status === 'invalid'
      "
    >
      <summary>资料依据与引用校验</summary>
      <p>{{ records.verification.value?.message }}</p>
      <p v-for="issue in records.verification.value?.issues" :key="issue">
        {{ issue }}
      </p>
      <el-button
        v-for="source in records.sources.value"
        :key="source.id"
        text
        @click="records.readSource(source.id)"
        >{{ source.filename }} · {{ source.sourceId }}</el-button
      >
    </details>
    <el-dialog
      :model-value="!!records.editing.value"
      title="修改方案"
      class="session-record-dialog"
      width="75%"
      :close-on-click-modal="false"
      :before-close="closeEditor"
      ><p>保存将重新检查方案并使旧确认失效，需要重新确认才能执行。</p>
      <el-alert
        v-if="records.error.value"
        :title="records.error.value"
        type="error"
        :closable="false"
      /><el-input
        v-model="records.draft.value"
        type="textarea"
        :rows="18"
        aria-label="结构化方案"
      /><template #footer
        ><el-button
          :disabled="records.saving.value"
          @click="records.editing.value = null"
          >取消</el-button
        ><el-button
          type="primary"
          :loading="records.saving.value"
          @click="records.save"
          >保存修订</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      :model-value="!!records.source.value"
      :title="records.source.value?.filename"
      class="session-record-dialog"
      width="70%"
      @close="records.source.value = null"
      ><p>{{ records.source.value?.sourceId }}</p>
      <pre>{{ records.source.value?.content }}</pre>
      <small>摘要：{{ records.source.value?.sha256 }}</small></el-dialog
    >
  </section>
</template>
