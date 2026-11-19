<script setup lang="ts">
import { computed } from 'vue'
import type { StudioSeries } from '@/types/studio/series'
import { episodeDestination, episodeStage } from '@/utils/studio/series'
import ExpandableText from '@/components/base/ExpandableText.vue'
import StudioMedia from '../StudioMedia.vue'

/** 整剧只汇总真实进度；无媒体时显示集序，不借用官网样图。 */
const props = defineProps<{ series: StudioSeries }>()
const emit = defineEmits<{ section: [string] }>()
const current = computed(
  () =>
    props.series.episodes.find(
      (episode) => episode.id === props.series.currentEpisodeId,
    ) ?? props.series.episodes[0],
)
</script>
<template>
  <div class="stack">
    <section v-if="current" class="series-next toolbar" aria-label="当前推进">
      <div class="series-grow">
        <span class="studio-meta">当前推进 · 第{{ current.number }}集</span>
        <h2>{{ current.title }}</h2>
        <span>{{ episodeStage(current) }}</span>
      </div>
      <router-link
        class="el-button el-button--primary"
        :to="episodeDestination(series.id, current)"
        >继续第{{ current.number }}集</router-link
      >
    </section>
    <div class="series-overview-grid">
      <section class="card stack" aria-label="剧集进度">
        <div class="toolbar">
          <h2 class="series-grow">剧集进度</h2>
          <span class="studio-meta"
            >已有成片 {{ series.deliveredCount }} /
            {{ series.episodeCount }} 集</span
          >
        </div>
        <p v-if="!series.episodes.length" class="empty-cell">
          从第一集的故事开始。<el-button
            link
            @click="emit('section', 'episodes')"
            >编排分集</el-button
          >
        </p>
        <ol class="series-episode-list">
          <li
            v-for="episode in series.episodes"
            :key="episode.id"
            class="series-episode-row"
            :class="{ 'is-current': current?.id === episode.id }"
          >
            <div class="series-thumb">
              <StudioMedia
                v-if="episode.coverJobId || episode.coverAssetId"
                :project="episode.projectId"
                :job="episode.coverJobId ?? undefined"
                :asset="episode.coverAssetId ?? undefined"
                kind="video"
                lazy
              /><span v-else>{{
                String(episode.number).padStart(2, '0')
              }}</span>
            </div>
            <div class="series-grow">
              <strong>第{{ episode.number }}集 · {{ episode.title }}</strong
              ><ExpandableText
                :text="episode.story.synopsis || '故事待补充'"
                :lines="2"
                label="本集故事"
              />
            </div>
            <span class="studio-meta"
              >{{ episodeStage(episode)
              }}{{ episode.locked ? ' · 已锁定' : '' }}</span
            >
            <router-link :to="episodeDestination(series.id, episode)">{{
              episode.deliverable ? '查看成片' : '继续'
            }}</router-link>
          </li>
        </ol>
      </section>
      <aside class="card stack">
        <div class="toolbar">
          <h2 class="series-grow">本剧设定</h2>
          <el-button link @click="emit('section', 'settings')"
            >管理设定</el-button
          >
        </div>
        <div class="series-portraits">
          <div
            v-for="asset in series.settings.slice(0, 6)"
            :key="asset.id"
            class="series-portrait"
          >
            <StudioMedia
              v-if="asset.fileId"
              :project="asset.project"
              :asset="asset.id"
              kind="image"
              lazy
            /><span v-else class="series-initial">{{
              asset.name.slice(0, 1)
            }}</span
            ><span>{{ asset.name }}</span>
          </div>
        </div>
        <p v-if="!series.settings.length" class="studio-meta">
          从素材库选定本剧共用的角色、场景和道具，新建分集会沿用这些版本。
        </p>
        <div class="series-divider" />
        <h2>故事方向</h2>
        <ExpandableText
          :text="series.brief || '尚未补充整剧构想'"
          :lines="6"
          label="整剧构想"
        />
        <p class="studio-meta">
          {{ series.narrativeMode === 'continuous' ? '连续剧情' : '单元故事' }}
          · 计划{{ series.plannedEpisodes }}集
        </p>
        <p
          v-if="
            series.episodes.some(
              (episode) => episode.settingsRevision < series.settingsRevision,
            )
          "
          class="studio-meta"
        >
          部分分集仍沿用旧设定。<el-button
            link
            @click="emit('section', 'settings')"
            >查看影响范围</el-button
          >
        </p>
      </aside>
    </div>
  </div>
</template>
