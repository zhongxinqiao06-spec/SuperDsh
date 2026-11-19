<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  EpisodeInput,
  SeriesEpisode,
  SeriesProposal,
  StoryField,
  StudioSeries,
} from '@/types/studio/series'
import { episodeDraft, episodeStage } from '@/utils/studio/series'
import { useMutation } from '@/composables/use-mutation'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import SeriesEpisodeEditor from './SeriesEpisodeEditor.vue'
import SeriesAssistant from './SeriesAssistant.vue'

/** 目录、故事和建议分别呈现；调整集序只传稳定身份，不按数组下标识别素材。 */
const props = defineProps<{
  series: StudioSeries
  selectedId: string
  allowed: boolean
  canAi: boolean
  busy: boolean
  add: (value: EpisodeInput) => Promise<void>
  save: (id: string, value: EpisodeInput) => Promise<void>
  confirm: (episode: SeriesEpisode) => Promise<void>
  lock: (episode: SeriesEpisode) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  reload: () => Promise<void>
  resolve: (
    record: SeriesProposal,
    action: 'apply' | 'discard',
    selected: { episodeId: string; fields: StoryField[] }[],
  ) => Promise<void>
}>()
const emit = defineEmits<{ select: [string] }>()
const current = computed(
  () =>
    props.series.episodes.find((episode) => episode.id === props.selectedId) ??
    props.series.episodes[0],
)
const creating = ref(false),
  ai = ref(false),
  pending = ref<string[]>([])
const form = ref(episodeDraft()),
  mutation = useMutation()
const formBaseline = ref('')
const editor = ref<InstanceType<typeof SeriesEpisodeEditor>>()
let dragged = ''
function start() {
  form.value = {
    ...episodeDraft(),
    title: `第${props.series.episodes.length + 1}集`,
    targetDurationMs: props.series.targetDurationMs ?? 45000,
  }
  formBaseline.value = JSON.stringify(form.value)
  creating.value = true
}
async function handleAdd() {
  if (await mutation.run(() => props.add(form.value))) {
    creating.value = false
    emit('select', props.series.episodes.at(-1)?.id ?? '')
  }
}
async function move(id: string, target: string) {
  if (id === target) return
  const ids = props.series.episodes.map((episode) => episode.id),
    from = ids.indexOf(id),
    to = ids.indexOf(target)
  if (from < 0 || to < 0) return
  ids.splice(to, 0, ...ids.splice(from, 1))
  await mutation.run(() => props.reorder(ids))
}
async function beforeGenerate() {
  return (await editor.value?.save()) ?? true
}
defineExpose({ saveCurrent: beforeGenerate })
</script>
<template>
  <section class="stack">
    <div class="toolbar">
      <el-button :disabled="!allowed || busy" @click="start">添加一集</el-button
      ><el-button :disabled="!canAi || !current || busy" @click="ai = !ai">{{
        ai ? '收起 AI 编排' : 'AI 协助编排'
      }}</el-button
      ><slot name="structure-actions" :current="current" />
    </div>
    <el-alert
      v-if="mutation.error.value"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <div class="series-planning" :class="{ 'has-assistant': ai && current }">
      <ScrollPanel class="series-panel series-directory" label="分集目录"
        ><template #header
          ><h2>分集目录 · {{ series.episodes.length }}</h2></template
        >
        <ol class="series-episode-list">
          <li
            v-for="(episode, index) in series.episodes"
            :key="episode.id"
            class="series-directory-item"
            :class="{ 'is-current': current?.id === episode.id }"
            :draggable="allowed && !episode.locked && !busy"
            @dragstart="dragged = episode.id"
            @dragover.prevent
            @drop.prevent="!episode.locked && move(dragged, episode.id)"
          >
            <button
              class="series-select"
              :aria-current="current?.id === episode.id ? 'true' : undefined"
              @click="emit('select', episode.id)"
            >
              <strong>第{{ episode.number }}集 · {{ episode.title }}</strong
              ><span class="studio-meta"
                >{{ episodeStage(episode)
                }}{{ episode.locked ? ' · 已锁定' : '' }}</span
              >
            </button>
            <div v-if="allowed" class="toolbar">
              <el-button
                link
                :disabled="
                  busy ||
                  episode.locked ||
                  index === 0 ||
                  series.episodes[index - 1]?.locked
                "
                :aria-label="`前移第${episode.number}集`"
                @click="move(episode.id, series.episodes[index - 1]!.id)"
                >前移</el-button
              ><el-button
                link
                :disabled="
                  busy ||
                  episode.locked ||
                  index === series.episodes.length - 1 ||
                  series.episodes[index + 1]?.locked
                "
                :aria-label="`后移第${episode.number}集`"
                @click="move(episode.id, series.episodes[index + 1]!.id)"
                >后移</el-button
              ><el-button
                link
                :disabled="busy"
                @click="mutation.run(() => lock(episode))"
                >{{ episode.locked ? '解锁' : '锁定' }}</el-button
              >
            </div>
          </li>
        </ol>
        <p v-if="!series.episodes.length" class="studio-meta">
          先添加第一集，或从已有分镜作品加入。
        </p>
        <template #footer
          ><span class="studio-meta"
            >已交付集默认锁定；重排前请核对前情。</span
          ></template
        >
      </ScrollPanel>
      <SeriesEpisodeEditor
        v-if="current"
        :key="current.id"
        ref="editor"
        :episode="current"
        :allowed="allowed"
        :busy="busy"
        :save="save"
        :confirm="confirm"
        :pending="pending.includes(current.id)"
        @ai="ai = true"
      />
      <div v-else class="card empty-cell">
        先确定本集要讲什么，AI 可以帮助起草，审阅后再开始制作。
      </div>
      <SeriesAssistant
        v-if="current"
        v-show="ai"
        :series="series"
        :current-id="current.id"
        :allowed="canAi && !busy"
        :before-generate="beforeGenerate"
        :reload="reload"
        :resolve="resolve"
        @pending="pending = $event"
        @close="ai = false"
      />
    </div>
    <ManagementDialog
      v-model="creating"
      title="添加一集"
      :dirty="JSON.stringify(form) !== formBaseline"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      :submit-disabled="!form.title.trim()"
      submit-text="添加草稿"
      @submit="handleAdd"
    >
      <div class="form-stack">
        <label class="field"
          >分集名称<el-input
            v-model="form.title"
            maxlength="120"
            aria-label="新分集名称" /></label
        ><label class="field"
          >本集构想<el-input
            v-model="form.story.synopsis"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            maxlength="12000"
            aria-label="新分集构想"
            placeholder="可以先写一句想法，随后借助 AI 完善。" /></label
        ><label class="field"
          >目标时长（秒）<el-input-number
            :model-value="form.targetDurationMs / 1000"
            :min="1"
            :max="3600"
            @update:model-value="
              form.targetDurationMs = Math.round(($event ?? 45) * 1000)
            "
        /></label>
      </div>
    </ManagementDialog>
  </section>
</template>
