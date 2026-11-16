<script setup lang="ts">
import { toRef } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { useResults } from '@/composables/workbench/use-results'
import ArtifactPreviewContent from './ArtifactPreviewContent.vue'
import SessionRecords from './SessionRecords.vue'

/** 技能阶段、真实成果和验证后的预览统一展示，不绑定特定办公工具名称。 */
const props = defineProps<{ sessionId: string; canWrite?: boolean }>()
const results = useResults(toRef(props, 'sessionId'))
defineExpose({ attachment: results.attachment })
const labels: Record<string, string> = {
  running: '进行中',
  'waiting-user': '等待确认',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
  failed: '失败',
  executing: '执行中',
}
</script>

<template>
  <section v-if="sessionId" aria-label="执行记录与成果" class="session-results">
    <SessionRecords :session-id="sessionId" :can-write="!!canWrite" />
    <el-alert
      v-if="results.error.value"
      :title="results.error.value"
      type="error"
      :closable="false"
    />
    <p
      v-if="
        results.loaded.value &&
        !results.error.value &&
        !results.runs.value.length &&
        !results.artifacts.value.length
      "
      class="office-results-empty"
    >
      当前会话暂无生成的文件。
    </p>
    <details
      v-for="run in results.runs.value"
      :key="run.id"
      :open="run.state !== 'completed'"
    >
      <summary>
        {{ run.skillName ?? '技能执行' }} ·
        {{ labels[run.state] ?? run.state }} · 修订 {{ run.revision }}
      </summary>
      <ol>
        <li v-for="(stage, index) in run.stages" :key="stage.id">
          {{ stage.name ?? stage.id }} ·
          {{
            index < run.stageIndex
              ? '已完成'
              : index === run.stageIndex
                ? (labels[run.state] ?? run.state)
                : '待执行'
          }}
        </li>
      </ol>
      <details>
        <summary>执行记录</summary>
        <pre>{{ JSON.stringify(run.outputs, null, 2) }}</pre>
      </details>
    </details>
    <article
      v-for="artifact in results.artifacts.value"
      :key="artifact.id"
      class="session-artifact"
    >
      <AppIcon name="file-text" /><span class="session-artifact-name">{{
        artifact.name
      }}</span
      ><el-tag
        v-if="
          artifact.deliverable === false ||
          artifact.renderedQuality?.status === 'draft'
        "
        type="warning"
        >草稿，质量检查未通过</el-tag
      ><el-button @click="results.preview(artifact)">预览</el-button
      ><el-button @click="results.download(artifact)">下载</el-button>
    </article>
    <section
      v-if="results.previewUrl.value"
      class="office-inline-preview"
      aria-label="成果预览内容"
    >
      <header>
        <strong>{{ results.previewName.value }}</strong
        ><el-button
          text
          aria-label="关闭文件预览"
          @click="results.closePreview()"
          ><AppIcon name="x"
        /></el-button>
      </header>
      <ArtifactPreviewContent :actions="results" />
    </section>
  </section>
</template>

<style scoped>
.office-inline-preview {
  margin: 16px 0;
  min-width: 0;
}
.office-inline-preview header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
}
.office-inline-preview strong {
  overflow-wrap: anywhere;
}
.office-inline-preview :deep(.preview),
.office-inline-preview :deep(.preview-image) {
  display: block;
  width: 100%;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 3px;
}
.office-inline-preview :deep(.preview) {
  height: min(52vh, 580px);
}
</style>
