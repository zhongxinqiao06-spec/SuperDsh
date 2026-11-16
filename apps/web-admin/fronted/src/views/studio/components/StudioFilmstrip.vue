<script setup lang="ts">
import type { Shot } from '@/types/studio/studio'
import StudioMedia from './StudioMedia.vue'

/** 底片条与分镜板共用镜头 ID；拖动排序后仍能回到同一镜头的剪辑位置。 */
defineProps<{
  project: string
  shots: Shot[]
  selected?: string
  reference: (shot: Shot) => string | undefined
}>()
const emit = defineEmits<{ select: [string] }>()
</script>
<template>
  <section class="panel studio-panel studio-filmstrip">
    <header>
      <h2>剪辑序列</h2>
      <router-link
        :to="{
          path: '/entertainment/' + project,
          query: { section: 'timeline', shot: selected },
        }"
        >进入时间线 →</router-link
      >
    </header>
    <div class="filmstrip-frames">
      <button
        v-for="(shot, i) in shots"
        :key="shot.id"
        type="button"
        :aria-label="'查看镜 ' + (i + 1)"
        :aria-pressed="selected === shot.id"
        @click="emit('select', shot.id)"
      >
        <span class="filmstrip-picture">
          <StudioMedia
            v-if="shot.candidate"
            :project="project"
            :job="shot.candidate"
            kind="video"
            lazy
          />
          <StudioMedia
            v-else-if="reference(shot)"
            :project="project"
            :asset="reference(shot)"
            kind="image"
            lazy
          />
          <span v-else>{{ shot.scene || '待选片' }}</span>
        </span>
        <span class="filmstrip-caption"
          ><strong>{{ String(i + 1).padStart(2, '0') }}</strong
          ><small
            >{{
              ((shot.trimEnd ?? shot.duration) - shot.trimStart) / 1000
            }}
            s</small
          ></span
        >
      </button>
    </div>
  </section>
</template>
<style scoped>
.studio-filmstrip {
  min-width: 0;
}
.studio-filmstrip header,
.filmstrip-caption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.studio-filmstrip header {
  margin-bottom: 10px;
}
.studio-filmstrip h2 {
  margin: 0;
  font-size: 15px;
}
.studio-filmstrip a {
  font-size: 12px;
  color: var(--muted-foreground);
}
.filmstrip-frames {
  display: flex;
  overflow-x: auto;
  gap: 7px;
  padding: 2px;
}
.filmstrip-frames button {
  flex: 0 0 clamp(94px, 13%, 145px);
  border: 1px solid var(--border);
  padding: 3px;
  border-radius: 5px;
  cursor: pointer;
  background: var(--card);
  color: var(--foreground);
}
.filmstrip-frames button[aria-pressed='true'] {
  border-color: var(--primary);
}
.filmstrip-picture {
  aspect-ratio: 16/9;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--studio-monitor, #222);
  color: var(--studio-monitor-ink, #eee);
  font-size: 11px;
}
.filmstrip-picture :deep(.studio-media),
.filmstrip-picture :deep(.studio-frame) {
  width: 100%;
  height: 100%;
  margin: 0;
  object-fit: cover;
}
.filmstrip-caption {
  padding: 5px 3px 2px;
  font-size: 11px;
}
</style>
