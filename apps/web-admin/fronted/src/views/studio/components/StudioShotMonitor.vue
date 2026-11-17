<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Job, Shot } from '@/types/studio/studio'
import StudioMedia from './StudioMedia.vue'

const props = defineProps<{
  shot: Shot
  project: string
  jobs: Job[]
  position: number
  reference?: string
  busy: boolean
  aspectWidth?: number | null
  aspectHeight?: number | null
}>()
const emit = defineEmits<{ adopt: [string] }>()
// 预览选择与工程采用状态独立。轮询送来新任务时，保持用户正在看的版本。
const candidates = computed(() =>
  props.jobs.filter(
    (j) =>
      j.kind === 'video' && j.subject === props.shot.id && j.state === 'ready',
  ),
)
const chosen = ref('')
const comparing = ref(false)
const active = computed(
  () =>
    candidates.value.find((j) => j.id === chosen.value) ??
    candidates.value.find((j) => j.id === props.shot.candidate) ??
    candidates.value[0],
)
const other = computed(
  () =>
    candidates.value.find(
      (j) => j.id === props.shot.candidate && j.id !== active.value?.id,
    ) ?? candidates.value.find((j) => j.id !== active.value?.id),
)
watch(
  () => active.value?.id,
  (id) => {
    chosen.value = id ?? ''
  },
  { immediate: true },
)
function takeLabel(id: string) {
  return (
    '候选 ' +
    (candidates.value.length - candidates.value.findIndex((j) => j.id === id))
  )
}
</script>
<template>
  <section
    class="studio-monitor-section"
    aria-label="镜头预览与候选"
    :style="{ '--shot-ratio': (aspectWidth || 16) / (aspectHeight || 9) }"
  >
    <div class="studio-monitor">
      <header>
        <h2>镜头预览</h2>
        <span>镜 {{ String(position).padStart(2, '0') }}</span>
      </header>
      <div class="studio-picture" :class="{ compare: comparing && other }">
        <figure v-if="active">
          <StudioMedia
            :project="project"
            :job="active.id"
            kind="video"
            controls
          />
          <figcaption>
            {{ takeLabel(active.id)
            }}{{ active.id === shot.candidate ? ' · 已采用' : '' }}
          </figcaption>
        </figure>
        <figure v-if="active && comparing && other">
          <StudioMedia
            :project="project"
            :job="other.id"
            kind="video"
            controls
          />
          <figcaption>
            {{ takeLabel(other.id)
            }}{{ other.id === shot.candidate ? ' · 已采用' : '' }}
          </figcaption>
        </figure>
        <StudioMedia
          v-if="!active && reference"
          :project="project"
          :asset="reference"
          kind="image"
        />
        <span v-if="!active && !reference" class="studio-monitor-empty"
          >暂无镜头画面</span
        >
      </div>
      <footer>
        <span
          >{{ shot.camera || '未设景别' }} · {{ shot.duration / 1000 }} 秒</span
        >
        <button
          v-if="other"
          type="button"
          :aria-pressed="comparing"
          @click="comparing = !comparing"
        >
          {{ comparing ? '退出对比' : '对比候选' }}
        </button>
      </footer>
    </div>
    <div class="panel studio-panel studio-takes">
      <div class="toolbar studio-take-heading">
        <h2>
          镜头候选 <small>{{ candidates.length }}</small>
        </h2>
        <el-button
          v-if="active"
          type="primary"
          :disabled="busy || active.id === shot.candidate"
          @click="emit('adopt', active.id)"
        >
          {{ active.id === shot.candidate ? '时间线已采用' : '采用到时间线' }}
        </el-button>
      </div>
      <p v-if="!candidates.length" class="studio-meta">
        生成完成的画面会出现在这里。
      </p>
      <div
        v-else
        class="studio-take-list"
        role="region"
        aria-label="镜头候选列表"
        tabindex="0"
        :class="{ 'studio-take-list--single': candidates.length === 1 }"
      >
        <button
          v-for="job in candidates"
          :key="job.id"
          type="button"
          :aria-pressed="job.id === active?.id"
          @click="chosen = job.id"
        >
          <StudioMedia :project="project" :job="job.id" kind="video" lazy />
          <strong>{{ takeLabel(job.id) }}</strong
          ><small
            >修订 {{ job.revision }} ·
            {{ job.id === shot.candidate ? '已采用' : '未采用' }}</small
          >
        </button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.studio-monitor-section {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
}
.studio-monitor {
  overflow: hidden;
  border-radius: 10px;
  background: var(--studio-monitor, #1c1d1f);
  color: var(--studio-monitor-ink, #f2eee6);
}
.studio-monitor header,
.studio-monitor footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
}
.studio-monitor h2,
.studio-takes h2 {
  margin: 0;
  font-size: 15px;
}
.studio-monitor button {
  border: 1px solid currentColor;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.studio-picture {
  display: grid;
  place-items: center;
  min-height: 220px;
  padding: var(--control-gap);
  background: #101113;
}
.studio-picture.compare {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
}
.studio-picture figure {
  position: relative;
  margin: 0;
  width: 100%;
  max-width: calc(min(52dvh, 520px) * var(--shot-ratio));
}
.studio-picture figcaption {
  position: absolute;
  top: 5px;
  left: 5px;
  padding: 2px 6px;
  background: #141416cf;
  color: #fff;
  font-size: 11px;
  pointer-events: none;
}
.studio-picture :deep(.studio-frame) {
  width: 100%;
  margin: 0;
  border-radius: 0;
  background: transparent;
  aspect-ratio: var(--shot-ratio);
  height: auto;
  max-height: min(52dvh, 520px);
  object-fit: contain;
}
.studio-picture > :deep(.studio-media) {
  max-width: calc(min(52dvh, 520px) * var(--shot-ratio));
  width: 100%;
}
.studio-monitor-empty {
  color: #c0bbb3;
  font-size: 13px;
}
.studio-takes small {
  color: var(--muted-foreground);
}
.studio-take-list {
  display: flex;
  gap: 8px;
  overflow: auto;
  margin: 12px 0;
  padding: 2px;
}
.studio-take-list button {
  flex: 0 0 136px;
  gap: var(--label-gap);
  padding: 5px;
  display: grid;
  text-align: left;
  background: var(--card);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.studio-take-list button[aria-pressed='true'] {
  border-color: var(--primary);
}
.studio-take-heading {
  justify-content: space-between;
}
.studio-take-list--single button {
  flex: 0 1 300px;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
}
.studio-take-list--single :deep(.studio-media) {
  grid-row: span 2;
}
.studio-take-list--single :deep(.studio-frame) {
  margin: 0;
}
@media (max-width: 600px) {
  .studio-picture.compare {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--field-gap);
  }
  .studio-monitor header,
  .studio-monitor footer {
    flex-wrap: wrap;
  }
}
</style>
