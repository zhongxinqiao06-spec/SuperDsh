<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  EpisodeInput,
  SeriesEpisode,
  SeriesStructurePlan,
  StudioSeries,
} from '@/types/studio/series'
import { emptyStory, episodeDraft, storyFields } from '@/utils/studio/series'
import { useMutation } from '@/composables/use-mutation'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'

/** 故事拆合先显示精确源集和新草稿，不暗示会自动迁移既有剪辑与媒体。 */
const props = defineProps<{
  series: StudioSeries
  episode: SeriesEpisode
  action: 'split' | 'merge'
  prepare: (
    ids: string[],
    episodes: EpisodeInput[],
  ) => Promise<SeriesStructurePlan>
  confirm: (plan: SeriesStructurePlan) => Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const selected = ref([props.episode.id]),
  episodes = ref<EpisodeInput[]>(
    props.action === 'split'
      ? [
          {
            ...episodeDraft(props.episode),
            title: props.episode.title + '（上）',
          },
          { ...episodeDraft(), title: props.episode.title + '（下）' },
        ]
      : [episodeDraft(props.episode)],
  )
const plan = ref<SeriesStructurePlan>(),
  mutation = useMutation()
const valid = computed(
  () =>
    episodes.value.every(
      (episode) => episode.title.trim() && episode.story.synopsis.trim(),
    ) &&
    (props.action === 'split' || selected.value.length > 1),
)
function assemble() {
  const chosen = props.series.episodes.filter((episode) =>
    selected.value.includes(episode.id),
  )
  const story = emptyStory()
  for (const field of storyFields)
    story[field.key] = chosen
      .map((episode) => episode.story[field.key])
      .filter(Boolean)
      .join('\n\n')
  episodes.value = [
    {
      title: chosen
        .map((episode) => episode.title)
        .join(' · ')
        .slice(0, 120),
      story,
      targetDurationMs: chosen.reduce(
        (sum, episode) => sum + episode.targetDurationMs,
        0,
      ),
    },
  ]
}
async function submit() {
  if (!plan.value)
    await mutation.run(async () => {
      plan.value = await props.prepare(selected.value, episodes.value)
    })
  else if (await mutation.run(() => props.confirm(plan.value!))) emit('close')
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="action === 'split' ? '拆分故事' : '合并故事'"
    width="min(900px, calc(100vw - 32px))"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :dirty="true"
    :submit-disabled="!valid"
    :submit-text="plan ? '确认调整分集结构' : '预览调整方案'"
    @submit="submit"
    @update:model-value="emit('close')"
  >
    <div class="form-stack">
      <el-alert
        title="这里只调整故事规划。原镜头、配音、剪辑和素材保留在只读历史工程，新分集需要重新确认和制作。"
        type="info"
        :closable="false"
      />
      <template v-if="!plan">
        <label v-if="action === 'merge'" class="field"
          >选择相邻分集<el-select
            v-model="selected"
            multiple
            aria-label="要合并的分集"
            @update:model-value="assemble"
            ><el-option
              v-for="entry in series.episodes"
              :key="entry.id"
              :value="entry.id"
              :label="`第${entry.number}集 · ${entry.title}`"
              :disabled="entry.locked || !!entry.deliverable" /></el-select
        ></label>
        <section
          v-for="(draft, index) in episodes"
          :key="index"
          class="form-stack series-diff"
        >
          <h3>新分集 {{ index + 1 }}</h3>
          <label class="field"
            >名称<el-input
              v-model="draft.title"
              maxlength="120"
              :aria-label="`新分集${index + 1}名称`" /></label
          ><label class="field"
            >本集故事<el-input
              v-model="draft.story.synopsis"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 10 }"
              maxlength="12000"
              :aria-label="`新分集${index + 1}故事`"
          /></label>
          <details>
            <summary>编辑开场、转折与结尾</summary>
            <div class="form-stack">
              <label
                v-for="field in storyFields.filter(
                  (item) => item.key !== 'synopsis',
                )"
                :key="field.key"
                class="field"
                >{{ field.label
                }}<el-input
                  v-model="draft.story[field.key]"
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 8 }"
                  maxlength="12000"
              /></label>
            </div>
          </details>
        </section>
      </template>
      <template v-else
        ><h3>将保留为只读历史的原集</h3>
        <ul>
          <li v-for="source in plan.sourceEpisodes" :key="source.id">
            {{ source.title }} · {{ source.shots }}个镜头 ·
            {{ source.mediaCount }}项制作记录
          </li>
        </ul>
        <h3>确认后建立的新分集</h3>
        <section
          v-for="(draft, index) in plan.episodes"
          :key="index"
          class="form-stack"
        >
          <strong>{{ draft.title }}</strong
          ><ExpandableText
            :text="draft.story.synopsis"
            :lines="8"
            label="新故事"
          />
        </section>
        <p class="studio-meta">{{ plan.notice }}</p>
        <el-button @click="plan = undefined">返回修改方案</el-button></template
      >
    </div>
  </ManagementDialog>
</template>
