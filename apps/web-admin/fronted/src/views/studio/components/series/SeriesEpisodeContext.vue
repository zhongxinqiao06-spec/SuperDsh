<script setup lang="ts">
import type { EpisodeContext } from '@/types/studio/series'
/** 系列上下文始终显示真实集序，切集交由宿主的草稿保护和既有路由执行。 */
defineProps<{ context: EpisodeContext; project: string }>()
const emit = defineEmits<{ open: [projectId: string] }>()
</script>
<template>
  <div class="toolbar episode-context" aria-label="所属短剧">
    <router-link :to="'/entertainment/series/' + context.seriesId"
      >← {{ context.seriesTitle }} · 整剧总览</router-link
    >
    <el-select
      v-if="!context.archived"
      :model-value="project"
      aria-label="切换分集"
      @update:model-value="emit('open', $event)"
      ><el-option
        v-for="episode in context.episodes"
        :key="episode.id"
        :value="episode.projectId"
        :label="`第${episode.number}集 · ${episode.title}`"
    /></el-select>
    <span v-if="context.archived" class="studio-meta"
      >历史工程 · {{ context.episodeTitle }} · 只读保留</span
    >
    <span v-else-if="context.seriesLifecycle === 'archived'" class="studio-meta"
      >整剧已归档 · 只读保留</span
    >
    <router-link
      :to="{
        path: '/entertainment/series/' + context.seriesId,
        query: { section: 'settings' },
      }"
      >沿用本剧设定{{
        context.settingsRevision < context.currentSettingsRevision
          ? ' · 有新版本'
          : ''
      }}</router-link
    >
  </div>
</template>
<style scoped>
.episode-context {
  padding: var(--field-gap);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}
.episode-context .el-select {
  width: min(100%, 320px);
}
</style>
