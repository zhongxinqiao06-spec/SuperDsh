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
  to?: string
  kindLabel?: string
  actionLabel?: string
  coverProjectId?: string | null
}>()
const emit = defineEmits<{ archive: [] }>()
const unavailable = ref(false)
watch(
  () => [props.project.coverJobId, props.project.coverAssetId],
  () => {
    unavailable.value = false
  },
)
</script>
<template>
  <article class="studio-project-entry">
    <router-link
      class="studio-project-card"
      :to="to ?? '/entertainment/' + project.id"
      :aria-label="project.title"
    >
      <div class="project-cover">
        <StudioMedia
          v-if="(project.coverJobId || project.coverAssetId) && !unavailable"
          :project="coverProjectId ?? project.id"
          :job="project.coverJobId ?? undefined"
          :asset="project.coverAssetId ?? undefined"
          kind="video"
          lazy
          @unavailable="unavailable = true"
        />
        <span v-else class="project-slate" aria-hidden="true"
          ><strong>{{ project.title }}</strong></span
        >
        <span class="project-revision">工程修订 {{ project.revision }}</span>
        <span v-if="kindLabel" class="project-kind">{{ kindLabel }}</span>
      </div>
      <div class="project-caption">
        <h2>{{ project.title }}</h2>
        <div class="project-summary">
          <slot name="summary"
            ><span class="project-stats"
              >{{ project.shots }} 个镜头 · {{ project.adopted }} 个已采用</span
            >
            <progress
              v-if="project.shots"
              :max="project.shots"
              :value="project.adopted"
              aria-label="镜头采用进度"
            />
            <span v-if="project.aspectWidth" class="project-specification"
              >{{ project.aspectWidth }}:{{ project.aspectHeight }} · 目标
              {{ (project.targetDurationMs ?? 0) / 1000 }} 秒</span
            ></slot
          >
        </div>
        <span class="project-updated"
          >最近更新 <DateTime :value="project.updated"
        /></span>
        <span class="project-open" aria-hidden="true"
          >{{ actionLabel ?? '进入作品' }} →</span
        >
      </div>
    </router-link>
    <div v-if="canEdit || $slots.actions" class="toolbar project-entry-actions">
      <slot name="actions" />
      <el-button
        v-if="canEdit"
        link
        :disabled="busy"
        @click="emit('archive')"
        >{{
          project.lifecycle === 'archived' ? '恢复作品' : '归档作品'
        }}</el-button
      >
    </div>
  </article>
</template>
<style scoped>
.studio-project-entry {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.project-entry-actions {
  padding: var(--control-gap);
  min-height: calc(32px + 2 * var(--control-gap));
  box-sizing: border-box;
}
.studio-project-card {
  display: grid;
  grid-template-rows: auto 1fr;
  flex: 1;
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
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 38px var(--field-gap) 44px;
  background: var(--selection-fill);
}
.project-slate strong {
  font-family: var(--font-editorial);
  font-weight: 600;
  font-size: clamp(20px, 2vw, 28px);
  line-height: 1.4;
  text-align: center;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  max-height: 100%;
  overflow: hidden;
}
.project-open {
  align-self: flex-end;
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 6px 10px;
  white-space: nowrap;
}
.project-kind {
  position: absolute;
  top: var(--control-gap);
  left: var(--control-gap);
  padding: 3px 8px;
  background: var(--card);
  border-radius: var(--radius-control);
  color: var(--foreground);
  font-size: var(--font-size-meta);
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
  display: flex;
  flex-direction: column;
  gap: var(--control-gap);
  padding: var(--field-gap);
  font-size: var(--font-size-meta);
  color: var(--muted-foreground);
}
.project-caption h2 {
  min-height: calc(var(--line-height-section) * 2);
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
  margin-top: auto;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px var(--control-gap);
  font-size: var(--font-size-meta);
}
.project-summary {
  display: flex;
  flex-direction: column;
  gap: var(--control-gap);
  min-height: 78px;
  overflow-wrap: anywhere;
}
.project-updated :deep(.date-time) {
  display: inline-flex;
  flex-direction: row;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--control-gap);
}
</style>
