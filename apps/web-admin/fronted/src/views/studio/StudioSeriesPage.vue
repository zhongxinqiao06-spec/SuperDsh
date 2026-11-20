<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import PageHeader from '@/components/layout/PageHeader.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import StudioBriefFields from './components/project/StudioBriefFields.vue'
import SeriesOverview from './components/series/SeriesOverview.vue'
import SeriesEpisodes from './components/series/SeriesEpisodes.vue'
import SeriesSettings from './components/series/SeriesSettings.vue'
import SeriesProduction from './components/series/SeriesProduction.vue'
import SeriesImportDialog from './components/series/SeriesImportDialog.vue'
import SeriesStructureDialog from './components/series/SeriesStructureDialog.vue'
import { useStudioSeries } from '@/composables/studio/use-studio-series'
import { useMutation } from '@/composables/use-mutation'
import { useActiveNavigation } from '@/composables/use-active-navigation'
import { useAuthStore } from '@/store/modules/auth-store'
import { seriesApi } from '@/api/studio/series-api'
import { projectBrief } from '@/utils/studio/foundation'
import { episodeDestination } from '@/utils/studio/series'
import type {
  EpisodeInput,
  SeriesBrief,
  SeriesEpisode,
  SeriesProposal,
  SeriesStructurePlan,
  StoryField,
} from '@/types/studio/series'
import type { WorkSummary } from '@/types/studio/works'
import '@/assets/styles/studio-series.css'

/** 整剧页面装配五个上下文入口，单集继续使用同一个专业制作工作台。 */
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore()
const id = String(route.params.id)
const { data, loading, busy, error, allowed, operation, reload, commit } =
  useStudioSeries(id)
const mutation = useMutation(),
  editing = ref(false)
const importing = ref(false),
  structure = ref<{ action: 'split' | 'merge'; episode: SeriesEpisode }>()
const episodeEditor = ref<InstanceType<typeof SeriesEpisodes>>()
const navigation = ref<HTMLElement>()
const brief = ref<SeriesBrief>({
  ...projectBrief(),
  narrativeMode: 'continuous',
  plannedEpisodes: 6,
})
const briefBaseline = ref('')
const sections = [
  { key: 'overview', title: '整剧总览' },
  { key: 'episodes', title: '故事与分集' },
  { key: 'settings', title: '本剧设定' },
  { key: 'production', title: '剧集制作' },
  { key: 'delivery', title: '成片交付' },
]
const section = computed(() =>
  sections.some((item) => item.key === route.query.section)
    ? String(route.query.section)
    : 'overview',
)
const selectedId = computed(() =>
  String(
    route.query.episode ??
      data.value?.currentEpisodeId ??
      data.value?.episodes[0]?.id ??
      '',
  ),
)
useActiveNavigation(navigation, () => section.value)
const canAi = computed(
  () => allowed.value && auth.can('sessions.read') && auth.can('sessions.run'),
)
function changeSection(value: string) {
  void router.push({
    path: route.path,
    query: { ...route.query, section: value, resume: undefined },
  })
}
function select(value: string) {
  void router.push({
    path: route.path,
    query: {
      ...route.query,
      section: 'episodes',
      episode: value,
      resume: undefined,
    },
  })
}
watch(
  data,
  (value) => {
    if (!value || route.query.resume !== '1') return
    const episode = value.episodes.find((item) => item.id === selectedId.value)
    if (episode) void router.replace(episodeDestination(value.id, episode))
  },
  { immediate: true },
)
function edit() {
  if (!data.value) return
  brief.value = {
    ...projectBrief(data.value),
    plannedEpisodes: data.value.plannedEpisodes,
    narrativeMode: data.value.narrativeMode,
  }
  briefBaseline.value = JSON.stringify(brief.value)
  editing.value = true
}
async function saveBrief() {
  if (
    await mutation.run(() =>
      commit(() =>
        seriesApi.update(id, {
          ...brief.value,
          ...operation(['brief', brief.value]),
        }),
      ),
    )
  )
    editing.value = false
}
async function saveCurrent() {
  if (episodeEditor.value && !(await episodeEditor.value.saveCurrent()))
    throw new Error('请先保存当前草稿后再调整分集')
}
async function add(value: EpisodeInput) {
  await saveCurrent()
  await commit(() =>
    seriesApi.addEpisode(id, { ...value, ...operation(['add', value]) }),
  )
}
async function save(target: string, value: EpisodeInput) {
  await commit(() =>
    seriesApi.saveEpisode(id, target, {
      ...value,
      ...operation(['save', target, value]),
    }),
  )
}
/** 取消和关闭都是保留当前编辑的正常路径，不能作为接口错误显示。 */
async function accepted(confirmation: Promise<unknown>): Promise<boolean> {
  try {
    await confirmation
    return true
  } catch (action) {
    if (action === 'cancel' || action === 'close') return false
    throw action
  }
}
async function confirm(episode: SeriesEpisode) {
  if (episode.confirmedStoryRevision !== episode.storyRevision) {
    if (
      episode.shots &&
      !(await accepted(
        ElMessageBox.confirm(
          '确认会更新本集故事正文，已有镜头、配音与剪辑保持原状，需要随后核对。',
          '确认本集故事',
          { confirmButtonText: '确认并继续', cancelButtonText: '继续编辑' },
        ),
      ))
    )
      return
    await commit(() =>
      seriesApi.confirmEpisode(id, episode.id, {
        ...operation(['confirm', episode.id, episode.projectRevision]),
        projectRevision: episode.projectRevision,
      }),
    )
  }
  await router.push({
    path: '/entertainment/' + episode.projectId,
    query: { section: episode.shots ? 'storyboard' : 'script' },
  })
}
async function lock(episode: SeriesEpisode) {
  if (
    !(await accepted(
      ElMessageBox.confirm(
        episode.locked
          ? '解锁后可以修改故事和制作工程，已交付版本仍可追溯。'
          : '锁定后本集不参与改写、重排和制作修改，随时可以明确解锁。',
        episode.locked ? '解锁本集' : '锁定本集',
        {
          confirmButtonText: episode.locked ? '解锁' : '锁定',
          cancelButtonText: '取消',
        },
      ),
    ))
  )
    return
  await saveCurrent()
  await commit(() =>
    seriesApi.lockEpisode(id, episode.id, {
      ...operation(['lock', episode.id, !episode.locked]),
      locked: !episode.locked,
    }),
  )
}
async function reorder(ids: string[]) {
  if (
    !(await accepted(
      ElMessageBox.confirm(
        '调整只改变播放集序，工程、素材和成片继续跟随原集。请随后核对前情和结尾承接。',
        '调整分集顺序',
        { confirmButtonText: '确认顺序', cancelButtonText: '取消' },
      ),
    ))
  )
    return
  await saveCurrent()
  await commit(() =>
    seriesApi.reorder(id, { ...operation(['order', ids]), episodeIds: ids }),
  )
}
async function saveSettings(ids: string[]) {
  await commit(() =>
    seriesApi.settings(id, {
      ...operation(['settings', ids]),
      assetVersionIds: ids,
    }),
  )
}
async function applySettings(ids: string[]) {
  const projectRevisions = Object.fromEntries(
    data
      .value!.episodes.filter((episode) => ids.includes(episode.id))
      .map((episode) => [episode.projectId, episode.projectRevision]),
  )
  await commit(() =>
    seriesApi.applySettings(id, {
      ...operation(['apply-settings', ids, projectRevisions]),
      episodeIds: ids,
      projectRevisions,
    }),
  )
}
async function resolve(
  record: SeriesProposal,
  action: 'apply' | 'discard',
  selected: { episodeId: string; fields: StoryField[] }[],
) {
  await commit(() =>
    seriesApi.resolve(id, record.id, {
      ...operation(['proposal', record.id, action, selected]),
      action,
      selected,
    }),
  )
}
async function importEpisode(work: WorkSummary) {
  await saveCurrent()
  await commit(() =>
    seriesApi.importEpisode(id, {
      ...operation(['import', work.id, work.revision]),
      projectId: work.id,
      projectRevision: work.revision,
    }),
  )
}
async function removeEpisode(episode?: SeriesEpisode) {
  if (!episode) return
  if (
    !(await accepted(
      ElMessageBox.confirm(
        `将「${episode.title}」移出分集目录。原工程、素材和制作记录仍保留为只读历史。`,
        '移除分集',
        {
          confirmButtonText: '确认移除',
          cancelButtonText: '取消',
          type: 'warning',
        },
      ),
    ))
  )
    return
  await mutation.run(async () => {
    await saveCurrent()
    const latest = data.value!.episodes.find((item) => item.id === episode.id)!
    await commit(() =>
      seriesApi.removeEpisode(id, latest.id, {
        ...operation(['remove', latest.id, latest.projectRevision]),
        projectRevision: latest.projectRevision,
      }),
    )
    select(data.value!.episodes[0]?.id ?? '')
  })
}
async function openStructure(
  action: 'split' | 'merge',
  episode?: SeriesEpisode,
) {
  if (!episode) return
  await mutation.run(async () => {
    await saveCurrent()
    structure.value = {
      action,
      episode: data.value!.episodes.find((item) => item.id === episode.id)!,
    }
  })
}
async function prepareStructure(ids: string[], episodes: EpisodeInput[]) {
  const action = structure.value!.action
  return seriesApi.structurePlan(id, {
    ...operation(['structure', action, ids, episodes]),
    action,
    episodeIds: ids,
    episodes,
  })
}
async function confirmStructure(plan: SeriesStructurePlan) {
  await commit(() =>
    seriesApi.confirmStructure(id, plan.id, {
      ...operation(['confirm-structure', plan.id, plan.planHash]),
      planHash: plan.planHash,
    }),
  )
  select(data.value!.episodes[0]?.id ?? '')
}
</script>
<template>
  <section class="page stack studio-series">
    <PageHeader :title="data?.title ?? '系列短剧'" />
    <div class="toolbar">
      <router-link to="/entertainment/works">← 我的作品</router-link
      ><span v-if="data" class="studio-meta series-grow"
        >{{ data.narrativeMode === 'continuous' ? '连续剧情' : '单元故事' }} ·
        计划{{ data.plannedEpisodes }}集 · 每集约{{
          (data.targetDurationMs ?? 0) / 1000
        }}秒<span v-if="data.aspectWidth">
          · {{ data.aspectWidth }}:{{ data.aspectHeight }}</span
        ></span
      ><el-button v-if="allowed && data" :disabled="busy" @click="edit"
        >编辑作品</el-button
      ><el-button :loading="loading" :disabled="busy" @click="reload"
        >刷新进度</el-button
      >
    </div>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data"
      @retry="reload"
    />
    <template v-if="data">
      <el-alert
        v-if="data.lifecycle === 'archived'"
        title="本剧已归档，当前以只读方式查看。可在我的作品中恢复。"
        type="info"
        :closable="false"
      />
      <nav ref="navigation" class="series-nav" aria-label="整剧工作区">
        <router-link
          v-for="item in sections"
          :key="item.key"
          :to="{
            path: route.path,
            query: { section: item.key, episode: selectedId },
          }"
          :aria-current="section === item.key ? 'page' : undefined"
          >{{ item.title }}</router-link
        >
      </nav>
      <SeriesOverview
        v-if="section === 'overview'"
        :series="data"
        @section="changeSection"
      />
      <SeriesEpisodes
        v-else-if="section === 'episodes'"
        ref="episodeEditor"
        :series="data"
        :selected-id="selectedId"
        :allowed="allowed"
        :can-ai="canAi"
        :busy="busy"
        :add="add"
        :save="save"
        :confirm="confirm"
        :lock="lock"
        :reorder="reorder"
        :reload="reload"
        :resolve="resolve"
        @select="select"
        ><template #structure-actions="{ current }"
          ><el-button :disabled="!allowed || busy" @click="importing = true"
            >从已有作品加入</el-button
          ><el-button
            :disabled="!allowed || busy || !current || current.locked"
            @click="openStructure('split', current)"
            >拆分故事</el-button
          ><el-button
            :disabled="
              !allowed ||
              busy ||
              !current ||
              current.locked ||
              data.episodes.length < 2
            "
            @click="openStructure('merge', current)"
            >合并故事</el-button
          ><el-button
            type="danger"
            plain
            :disabled="!allowed || busy || !current || current.locked"
            @click="removeEpisode(current)"
            >移除本集</el-button
          ></template
        ></SeriesEpisodes
      >
      <SeriesSettings
        v-else-if="section === 'settings'"
        :series="data"
        :allowed="allowed"
        :busy="busy"
        :save="saveSettings"
        :apply="applySettings"
      />
      <SeriesProduction
        v-else
        :series="data"
        :delivery="section === 'delivery'"
      />
      <details
        v-if="data.archivedEpisodes.length && section === 'episodes'"
        class="card"
      >
        <summary>保留的历史分集 · {{ data.archivedEpisodes.length }}</summary>
        <ul>
          <li v-for="episode in data.archivedEpisodes" :key="episode.id">
            <router-link :to="'/entertainment/' + episode.projectId">{{
              episode.title
            }}</router-link>
            · {{ episode.reason }}
          </li>
        </ul>
      </details>
    </template>
    <ManagementDialog
      v-model="editing"
      title="编辑整剧规格"
      :dirty="JSON.stringify(brief) !== briefBaseline"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      :submit-disabled="!brief.title.trim()"
      @submit="saveBrief"
      ><StudioBriefFields v-model="brief" per-episode /><label class="field"
        >计划集数<el-input-number
          v-model="brief.plannedEpisodes"
          :min="1"
          :max="100"
      /></label>
      <p class="studio-meta">
        规格修改不会重写已有单集工程，新增集会沿用新规格。
      </p></ManagementDialog
    >
    <SeriesImportDialog
      v-if="importing"
      :submit="importEpisode"
      @close="importing = false"
    />
    <SeriesStructureDialog
      v-if="structure && data"
      :series="data"
      :episode="structure.episode"
      :action="structure.action"
      :prepare="prepareStructure"
      :confirm="confirmStructure"
      @close="structure = undefined"
    />
  </section>
</template>
