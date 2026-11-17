<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import { computed, ref, watch } from 'vue'
import { preparationApi } from '@/api/studio/preparation-api'
import type { StageState, StageConfirmation } from '@/types/studio/preparation'
import type { StudioProject } from '@/types/studio/studio'

/** 确认针对当前内容；非必需参考允许逐项略过，试片跳过必须留理由。 */
const props = defineProps<{
  state: StageState
  project: StudioProject
  readonly: boolean
  save: () => Promise<void>
}>()
const emit = defineEmits<{ confirmed: []; locate: [string] }>()
const acknowledged = ref(false),
  waived = ref<string[]>([]),
  reason = ref(''),
  selected = ref<string[]>([]),
  busy = ref(false),
  error = ref(''),
  expanded = ref(false)
let intent: { signature: string; key: string } | undefined
const labels: Record<string, string> = {
  confirmed: '本阶段已确认',
  skipped: '已记录跳过理由',
  stale: '内容已变化，请重新确认',
  blocked: '还有内容需要补充',
  needs_review: '内容准备好后，确认并继续',
}
const next: Record<string, string> = {
  script: '确认剧本，进入人物设定',
  cast: '确认设定，进入分镜',
  storyboard: '确认分镜，进入试做',
  sample: '确认试片，进入制作',
}
const unresolved = computed(() =>
  props.state.issues.some((i) => !waived.value.includes(i.key)),
)
const completed = computed(() =>
  ['confirmed', 'skipped'].includes(props.state.status),
)
watch(
  () => props.state.key,
  () => {
    acknowledged.value = false
    waived.value = []
    reason.value = ''
    selected.value = []
    error.value = ''
    expanded.value = false
  },
)
async function confirm(skipped = false) {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    await props.save()
    const data = {
      revision: props.project.revision,
      decision: skipped ? ('skipped' as const) : ('confirmed' as const),
      reason: reason.value,
      acknowledged: acknowledged.value,
      waived: waived.value,
      shots: selected.value,
    }
    const signature = JSON.stringify([props.state.key, data])
    if (intent?.signature !== signature)
      intent = { signature, key: createUuid() }
    const body: StageConfirmation = { ...data, requestKey: intent.key }
    await preparationApi.confirm(props.project.id, props.state.key, body)
    intent = undefined
    emit('confirmed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="preparation-review panel" aria-label="阶段检查与确认">
    <div class="toolbar">
      <div class="preparation-review-title">
        <span class="eyebrow">当前步骤 · {{ state.title }}</span>
        <h2>{{ labels[state.status] }}</h2>
        <p v-if="state.status === 'stale'">
          已生成的素材和手工剪辑仍保留，只需重新审阅本次变化。
        </p>
      </div>
      <span class="toolbar-spacer" /><el-button @click="expanded = !expanded">{{
        expanded
          ? '收起检查'
          : `查看检查${state.issues.length ? ' · ' + state.issues.length : ''}`
      }}</el-button>
      <el-button
        v-if="completed && !readonly"
        type="primary"
        @click="emit('confirmed')"
        >进入下一步</el-button
      >
    </div>
    <div v-if="expanded" class="form-stack">
      <p v-if="!state.issues.length" class="studio-meta">
        当前基础检查通过。请核对内容与创作意图，再确认。
      </p>
      <div
        v-for="issue in state.issues"
        :key="issue.key"
        class="preparation-check"
      >
        <span>{{ issue.message }}</span
        ><el-button
          v-if="issue.target"
          text
          @click="emit('locate', issue.target)"
          >定位</el-button
        ><el-checkbox
          v-if="issue.waivable && !readonly"
          :model-value="waived.includes(issue.key)"
          @update:model-value="
            (value: unknown) =>
              (waived = value
                ? [...waived, issue.key]
                : waived.filter((key) => key !== issue.key))
          "
          >本次不需要</el-checkbox
        >
      </div>
      <template v-if="state.key === 'sample'"
        ><p>选择已经审看并采用的代表镜头：</p>
        <el-checkbox-group v-model="selected"
          ><el-checkbox
            v-for="(shot, index) in project.document.shots"
            :key="shot.id"
            :value="shot.id"
            :disabled="!shot.candidate || readonly"
            >镜 {{ index + 1 }} ·
            {{ shot.scene || shot.action.slice(0, 48) || '未命名镜头' }} ·
            {{ shot.duration / 1000 }} 秒</el-checkbox
          ></el-checkbox-group
        ></template
      >
      <label v-if="waived.length || state.key === 'sample'" class="field"
        >略过理由<el-input
          v-model="reason"
          type="textarea"
          :rows="2"
          :disabled="readonly"
          placeholder="说明为何不需要这些素材，或为何本次无需试片"
          aria-label="略过理由"
      /></label>
      <p v-if="state.review?.reason" class="studio-meta">
        上次确认：{{ state.review.reason }}
      </p>
    </div>
    <div v-if="!readonly && !completed" class="toolbar">
      <el-checkbox v-model="acknowledged"
        >我已审阅{{
          state.key === 'storyboard'
            ? '画面、台词和预演节奏'
            : state.key === 'sample'
              ? '所选试片效果'
              : '本阶段内容'
        }}</el-checkbox
      ><span class="toolbar-spacer" /><el-button
        v-if="state.key === 'sample'"
        :disabled="busy || !reason.trim()"
        @click="confirm(true)"
        >记录理由并跳过试片</el-button
      ><el-button
        type="primary"
        :loading="busy"
        :disabled="
          !acknowledged ||
          unresolved ||
          (waived.length > 0 && !reason.trim()) ||
          (state.key === 'sample' && !selected.length)
        "
        @click="confirm()"
        >{{ next[state.key] }}</el-button
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
  </section>
</template>
