<script setup lang="ts">
import { ref, watch } from 'vue'
import DateTime from '@/components/base/DateTime.vue'
import type { ProjectSummary } from '@/types/studio/studio'
import StudioMedia from './StudioMedia.vue'

/** 已采用的镜头作为封面；尚无画面时以真实片名排印。 */
const props = defineProps<{
  project: ProjectSummary
  canEdit?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ archive: [] }>()
const unavailable = ref(false)
watch(
  () => props.project.coverJobId,
  () => {
    unavailable.value = false
  },
)
</script>
<template>
  <article class="studio-project-entry">
    <router-link
      class="studio-project-card"
      :to="'/entertainment/' + project.id"
      :aria-label="project.title"
    >
      <div class="project-cover">
        <StudioMedia
          v-if="project.coverJobId && !unavailable"
          :project="project.id"
          :job="project.coverJobId"
          kind="video"
          lazy
          @unavailable="unavailable = true"
        />
        <span v-else class="project-slate" aria-hidden="true"
          ><strong>{{ project.title }}</strong></span
        >
        <span class="project-revision">工程修订 {{ project.revision }}</span>
      </div>
      <div class="project-caption">
        <h2>{{ project.title }}</h2>
        <span>{{ project.shots }} 个镜头 · {{ project.adopted }} 个已采用</span>
        <progress
          v-if="project.shots"
          :max="project.shots"
          :value="project.adopted"
          aria-label="镜头采用进度"
        />
        <span v-if="project.aspectWidth"
          >{{ project.aspectWidth }}:{{ project.aspectHeight }} · 目标
          {{ (project.targetDurationMs ?? 0) / 1000 }} 秒</span
        >
        <span class="project-updated"
          >最近更新 <DateTime :value="project.updated"
        /></span>
        <span class="project-open" aria-hidden="true">进入作品 →</span>
      </div>
    </router-link>
    <div v-if="canEdit" class="toolbar project-entry-actions">
      <el-button link :disabled="busy" @click="emit('archive')">{{
        project.lifecycle === 'archived' ? '恢复作品' : '归档作品'
      }}</el-button>
    </div>
  </article>
</template>
<style scoped>
.studio-project-entry {
  min-width: 0;
}
.project-entry-actions {
  padding: var(--control-gap);
}
.studio-project-card {
  display: grid;
  align-content: start;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--card);
  color: var(--foreground);
  text-decoration: none;
  box-shadow: var(--shadow-card);
  transition:
    border-color var(--transition-ui),
    box-shadow var(--transition-ui);
}
.studio-project-card:hover,
.studio-project-card:focus-visible {
  border-color: var(--primary);
  box-shadow: var(--shadow-floating);
}
.project-cover {
  position: relative;
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--accent);
  color: var(--selection-ink);
}
.project-cover :deep(.studio-media),
.project-cover :deep(.studio-frame) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.project-slate {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--selection-fill);
}
.project-slate strong {
  font-family: var(--font-editorial);
  font-weight: 600;
  font-size: clamp(22px, 2.4vw, 32px);
  line-height: 1.4;
  text-align: center;
  padding: 8%;
  overflow-wrap: anywhere;
  max-height: 100%;
  overflow: hidden;
}
.studio-project-card:only-child .project-cover {
  aspect-ratio: 2.45;
}
.project-open {
  grid-column: 2;
  grid-row: 1/4;
  align-self: center;
  justify-self: end;
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 6px 10px;
  white-space: nowrap;
}
.project-caption > :not(.project-open) {
  grid-column: 1;
}
@media (max-width: 600px) {
  .studio-project-card:only-child .project-cover {
    aspect-ratio: 1.65;
  }
}
.project-revision {
  position: absolute;
  bottom: 10px;
  right: 10px;
  background: var(--card);
  color: var(--muted-foreground);
  padding: 3px 8px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  font-size: var(--font-size-meta);
}
.project-caption {
  display: grid;
  gap: 8px;
  padding: var(--field-gap);
  font-size: var(--font-size-meta);
  color: var(--muted-foreground);
}
.project-caption h2 {
  margin: 0;
  color: var(--foreground);
  font-size: var(--font-size-section);
  line-height: var(--line-height-section);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.project-caption progress {
  width: 100%;
  height: 4px;
  accent-color: var(--primary);
}
.project-updated {
  font-size: 12px;
}
</style>
