<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import type { StudioSeries } from '@/types/studio/series'
import { episodeDestination, episodeStage } from '@/utils/studio/series'
import StudioMedia from '../StudioMedia.vue'
import { studioApi } from '@/api/studio/studio-api'
import { useMutation } from '@/composables/use-mutation'

/** 各集保留独立工程与交付快照；此处汇总入口不创建第二条生成队列。 */
const props = defineProps<{ series: StudioSeries; delivery?: boolean }>()
const query = ref(''),
  mutation = useMutation()
const controller = new AbortController()
onScopeDispose(() => controller.abort())
const episodes = computed(() =>
  props.series.episodes.filter(
    (episode) =>
      (!props.delivery || episode.deliverable) &&
      episode.title.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
)
async function saveVideo(project: string, job: string, title: string) {
  await mutation.run(async () => {
    const url = await studioApi.media(project, job, true, controller.signal)
    if (controller.signal.aborted) return
    const link = document.createElement('a')
    link.href = url
    link.download = title + '.mp4'
    link.click()
  })
}
</script>
<template>
  <section class="stack">
    <div class="toolbar">
      <el-input
        v-model="query"
        aria-label="搜索分集"
        placeholder="搜索分集名称"
      />
    </div>
    <el-alert
      v-if="mutation.error.value"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <p v-if="!episodes.length" class="empty-cell">
      {{
        delivery
          ? '还没有可交付的成片。进入单集完成剪辑并导出后，会在这里汇总。'
          : '暂无匹配的分集。先到故事与分集添加本集故事。'
      }}
    </p>
    <div class="series-production-grid">
      <article v-for="episode in episodes" :key="episode.id" class="card stack">
        <h2>第{{ episode.number }}集 · {{ episode.title }}</h2>
        <StudioMedia
          v-if="delivery && episode.deliverable"
          :project="episode.projectId"
          :job="episode.deliverable.jobId"
          kind="video"
          controls
        />
        <p>
          {{ episodeStage(episode) }} · {{ episode.shots }}个镜头 ·
          {{ episode.adopted }}个已采用
        </p>
        <p v-if="episode.deliverable" class="studio-meta">
          交付工程修订 {{ episode.deliverable.revision
          }}{{
            episode.deliverable.revision !== episode.projectRevision
              ? ' · 当前工程已有后续修改'
              : ''
          }}
        </p>
        <div class="toolbar">
          <router-link
            :to="
              delivery
                ? {
                    path: '/entertainment/' + episode.projectId,
                    query: { section: 'delivery' },
                  }
                : episodeDestination(series.id, episode)
            "
            >{{ delivery ? '查看交付与版本' : '进入单集制作' }} →</router-link
          ><el-button
            v-if="delivery && episode.deliverable"
            :disabled="mutation.busy.value"
            @click="
              saveVideo(
                episode.projectId,
                episode.deliverable.jobId,
                episode.title,
              )
            "
            >下载本集</el-button
          >
        </div>
      </article>
    </div>
  </section>
</template>
