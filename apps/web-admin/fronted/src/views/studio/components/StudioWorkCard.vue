<script setup lang="ts">
import type { WorkSummary } from '@/types/studio/works'
import {
  workAction,
  workLocation,
  workModeLabels,
  workStageLabels,
} from '@/utils/studio/works'
import StudioProjectCard from './StudioProjectCard.vue'

/** 统一目录只呈现真实汇总与有权读取的封面，不以样例填补空态。 */
defineProps<{ work: WorkSummary; canEdit: boolean; busy: boolean }>()
const emit = defineEmits<{ archive: [] }>()
</script>
<template>
  <StudioProjectCard
    :project="work"
    :to="workLocation(work)"
    :kind-label="workModeLabels[work.kind]"
    :action-label="workAction(work)"
    :cover-project-id="work.coverProjectId"
    :can-edit="canEdit"
    :busy="busy"
    @archive="emit('archive')"
  >
    <template #summary>
      <template v-if="work.kind === 'series'">
        <span
          >{{ work.episodeCount }} 集 · 已交付
          {{ work.deliveredCount }} 集</span
        >
        <span v-if="work.currentEpisodeNumber"
          >当前：第 {{ work.currentEpisodeNumber }} 集<span
            v-if="work.currentStage"
          >
            · {{ workStageLabels[work.currentStage] ?? '继续制作' }}</span
          ></span
        >
        <span v-else>从整剧构想开始，逐集确认故事与制作。</span>
      </template>
      <template v-else>
        <span v-if="work.kind === 'storyboard'"
          >{{ work.shots }} 个镜头 · {{ work.adopted }} 个已采用</span
        >
        <span v-else>单条视频创作 · 候选与参数持续保留</span>
        <span v-if="work.aspectWidth"
          >{{ work.aspectWidth }}:{{ work.aspectHeight
          }}<template v-if="work.targetDurationMs">
            · 目标 {{ work.targetDurationMs / 1000 }} 秒</template
          ></span
        >
      </template>
    </template>
    <template v-if="work.kind === 'series'" #actions
      ><router-link :to="'/entertainment/series/' + encodeURIComponent(work.id)"
        >整剧总览</router-link
      ></template
    >
  </StudioProjectCard>
</template>
