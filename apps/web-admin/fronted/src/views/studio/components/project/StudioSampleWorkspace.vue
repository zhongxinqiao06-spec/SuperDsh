<script setup lang="ts">
import { computed } from 'vue'
import type { StudioProject } from '@/types/studio/studio'
import StudioShotMonitor from '../StudioShotMonitor.vue'
import { sampleProgress } from '@/utils/studio/sample-progress'

/** 代表镜头与全量制作分开：只提交用户选中的一镜及其台词。 */
const props = defineProps<{
  project: StudioProject
  readonly: boolean
  canGenerate: boolean
  busy: boolean
  selected: string
  reference: (
    shot: StudioProject['document']['shots'][number],
  ) => string | undefined
}>()
const emit = defineEmits<{
  select: [string]
  generate: [string[], string[]]
  adopt: [string]
}>()
const shot = computed(
  () =>
    props.project.document.shots.find((s) => s.id === props.selected) ??
    props.project.document.shots[0],
)
const progress = computed(() => sampleProgress(shot.value, props.project.jobs))
const tasksLink = computed(() => ({
  path: '/entertainment/' + encodeURIComponent(props.project.id),
  query: { section: 'production' },
}))
</script>
<template>
  <section class="sample-workspace">
    <aside class="panel preparation-candidate">
      <span class="eyebrow">先验证，再批量制作</span>
      <h2>选一镜验证效果</h2>
      <p>
        优先选择同时包含主要人物、场景和对白的镜头。满意的结果可直接采用，后续无需再做一遍。
      </p>
      <label class="field"
        >代表镜头<el-select
          :model-value="shot?.id"
          aria-label="代表镜头"
          @update:model-value="emit('select', $event)"
          ><el-option
            v-for="(item, index) in project.document.shots"
            :key="item.id"
            :value="item.id"
            :label="`镜 ${index + 1} · ${item.scene || item.action.slice(0, 48) || '未命名镜头'}`" /></el-select
      ></label>
      <p v-if="shot">
        {{ shot.duration / 1000 }} 秒 · {{ shot.lines.length }} 句台词
      </p>
      <section
        v-if="progress.total"
        class="form-stack sample-progress"
        aria-label="本镜制作进度"
        aria-live="polite"
      >
        <strong>本镜制作进度</strong>
        <dl>
          <template v-for="row in progress.rows" :key="row.kind">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.summary }}</dd>
          </template>
        </dl>
        <p v-if="progress.active" class="studio-meta">
          任务已经提交，完成的画面会进入右侧候选。配音进度可在制作任务中查看。
        </p>
        <p v-else-if="progress.unresolved" class="studio-meta">
          已有任务受理结果待核对，请先查看任务记录，避免重复生成。
        </p>
        <p v-else-if="progress.failed" class="studio-meta">
          有任务失败，可以查看原因后重新检查本镜；已完成的候选会保留。
        </p>
        <router-link :to="tasksLink" class="sample-tasks-link">{{
          progress.unresolved ? '查看制作任务并核对' : '查看制作任务'
        }}</router-link>
      </section>
      <el-button
        v-if="!readonly && canGenerate"
        type="primary"
        :disabled="!shot || busy || progress.active || progress.unresolved"
        @click="
          shot &&
          !progress.active &&
          !progress.unresolved &&
          emit(
            'generate',
            [shot.id],
            shot.lines.map((l) => l.id),
          )
        "
        >{{
          progress.active
            ? '本镜正在制作'
            : progress.unresolved
              ? '请先核对本镜任务'
              : '确认本镜试做范围'
        }}</el-button
      >
      <p v-if="!shot">先返回分镜设计，添加或采用镜头。</p>
    </aside>
    <StudioShotMonitor
      v-if="shot"
      :key="shot.id"
      :shot="shot"
      :project="project.id"
      :jobs="project.jobs"
      :reference="reference(shot)"
      :position="project.document.shots.indexOf(shot) + 1"
      :busy="readonly || busy"
      @adopt="emit('adopt', $event)"
    />
  </section>
</template>
<style scoped>
.sample-progress {
  border-block: 1px solid var(--border);
  padding-block: var(--field-gap);
}
.sample-progress dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--control-gap) var(--field-gap);
  margin: 0;
  font-size: var(--font-size-meta);
}
.sample-progress dt {
  color: var(--muted-foreground);
}
.sample-progress dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.sample-tasks-link {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
