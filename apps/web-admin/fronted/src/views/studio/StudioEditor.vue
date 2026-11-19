<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import StudioProjectBrief from './components/project/StudioProjectBrief.vue'
import StudioScript from './components/project/StudioScript.vue'
import StudioTextEditor from './components/project/StudioTextEditor.vue'
import type { TextEditTarget } from '@/types/studio/text-edit'
import StudioScriptReview from './components/project/StudioScriptReview.vue'
import type { DirectorAction } from '@/types/studio/director'
import StudioStageNav from './components/project/StudioStageNav.vue'
import StudioStageReview from './components/project/StudioStageReview.vue'
import StudioProposalReview from './components/project/StudioProposalReview.vue'
import StudioCastWorkspace from './components/project/StudioCastWorkspace.vue'
import StudioBoardPreparation from './components/project/StudioBoardPreparation.vue'
import StudioAnimatic from './components/project/StudioAnimatic.vue'
import StudioSampleWorkspace from './components/project/StudioSampleWorkspace.vue'
import { useStudioPreparation } from '@/composables/studio/use-studio-preparation'
import '@/assets/styles/studio-preparation.css'
import '@/assets/styles/studio-workspace.css'
import { nextFoundationStep } from '@/utils/studio/foundation'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router'
import PageHeader from '@/components/layout/PageHeader.vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import GenerationDialog from './components/GenerationDialog.vue'
import ProductionPlanDialog from './components/ProductionPlanDialog.vue'
import { productionApi } from '@/api/studio/production-api'
import { useProductionPlan } from '@/composables/studio/use-production-plan'
import { useAuthStore } from '@/store/modules/auth-store'
import { useStudioEditor } from '@/composables/studio/use-studio-editor'
import { studioApi } from '@/api/studio/studio-api'
import {
  duplicateShot,
  moveShot,
  newShot,
  removeShot,
  splitShot,
  voiceDurations,
} from '@/utils/studio/storyboard'
import { jobKinds, jobStates } from '@/utils/studio/media-labels'
import type { Generation, Shot, StudioAsset } from '@/types/studio/studio'
import { applyAssetUse, type AssetUseTarget } from '@/utils/studio/asset-use'
import { prepareAssetUse } from '@/composables/studio/prepare-asset-use'
import StudioAssetPicker from './components/library/StudioAssetPicker.vue'
import StudioCollectionDialog from './components/library/StudioCollectionDialog.vue'
import StudioMedia from './components/StudioMedia.vue'
import StudioMediaPreview from './components/StudioMediaPreview.vue'
import DirectorChat from './components/DirectorChat.vue'
import ShotEditor from './components/ShotEditor.vue'
import StudioLibrary from './components/StudioLibrary.vue'
import StudioTimeline from './components/StudioTimeline.vue'
import StudioShotMonitor from './components/StudioShotMonitor.vue'
import StudioWorkspace from './components/StudioWorkspace.vue'
import StudioFilmstrip from './components/StudioFilmstrip.vue'
import StudioRecovery from './components/StudioRecovery.vue'
import StudioProductionWorkspace from './components/project/StudioProductionWorkspace.vue'
import SeriesEpisodeContext from './components/series/SeriesEpisodeContext.vue'
import { useEpisodeContext } from '@/composables/studio/use-episode-context'
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const id = String(route.params.project)
const episodeContext = useEpisodeContext(id)
const {
  project: p,
  catalog,
  busy,
  saving,
  error,
  notice,
  dirty,
  stale,
  save,
  reload,
  run,
  asset,
  submit,
  show,
  preview,
  voices,
  linked,
  selectedVideo,
  selectedReference,
  selectedSpeech,
  importAsset,
  applyLibraryResult,
} = useStudioEditor(id)
const assetPicker = ref<{
  title: string
  kinds: StudioAsset['kind'][]
  target: AssetUseTarget
}>()
const collection = ref<StudioAsset>()
function pickAsset(value: {
  title: string
  kinds: StudioAsset['kind'][]
  target: AssetUseTarget
}) {
  assetPicker.value = value
}
async function resolveAsset(source: StudioAsset) {
  const target = assetPicker.value?.target
  if (!target || readonly.value) throw new Error('当前作品不可编辑')
  if (!p.value) throw new Error('作品已关闭')
  const prepared = await prepareAssetUse(source, target, p.value.document)
  const asset = await importAsset(prepared.asset)
  if (!p.value) throw new Error('作品已关闭')
  applyAssetUse(p.value.document, asset, prepared.target)
  await save('选用素材库素材')
  return asset
}
async function collectAsset(source: StudioAsset) {
  await run(async () => {
    await save()
    collection.value = source
  })
}
const {
  state: preparation,
  error: preparationError,
  refresh: refreshPreparation,
} = useStudioPreparation(p)
const directorOpen = ref(false),
  animaticOpen = ref(false)
const directorAction = ref<DirectorAction>()
const textEditorOpen = ref(false),
  textEditorBusy = ref(false),
  textEditorDraft = ref(false)
const textTarget = ref<TextEditTarget>()
async function openTextEditor(target?: TextEditTarget) {
  if (target && JSON.stringify(target) !== JSON.stringify(textTarget.value)) {
    if (textEditorDraft.value) {
      try {
        await ElMessageBox.confirm(
          '当前还有未发送的要求或未采用的调整。切换范围会重新填写要求，已生成的建议仍可在修改记录中查看。',
          '切换编辑范围',
          { confirmButtonText: '切换范围', cancelButtonText: '继续当前编辑' },
        )
      } catch {
        return
      }
    }
    textTarget.value = target
  }
  textEditorOpen.value = true
}
const scriptWorkspace = ref<InstanceType<typeof StudioScript>>()
const proposalPanel = ref<HTMLElement>()
const canDirect = computed(
  () => auth.can('sessions.read') && auth.can('sessions.run'),
)
function openDirector(action?: DirectorAction) {
  directorAction.value = action
  directorOpen.value = true
}
async function reviewProposal() {
  directorOpen.value = false
  if (section.value !== 'script' && section.value !== 'storyboard')
    await router.push(sectionLink('script'))
  await nextTick()
  proposalPanel.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  proposalPanel.value?.focus({ preventScroll: true })
}
function openSceneShot(id: string) {
  void router.push({
    ...sectionLink('storyboard'),
    query: { ...route.query, section: 'storyboard', shot: id },
  })
}
const castWorkspace = ref<InstanceType<typeof StudioCastWorkspace>>()
watch(
  [() => route.query.asset, () => castWorkspace.value],
  ([assetId, workspace]) => {
    if (typeof assetId === 'string' && workspace) workspace.inspect(assetId)
  },
  { flush: 'post' },
)
const sections = [
  { key: 'brief', title: '作品构想' },
  { key: 'script', title: '剧本与场次' },
  { key: 'cast', title: '角色与场景' },
  { key: 'storyboard', title: '分镜设计' },
  { key: 'sample', title: '试做一镜' },
  { key: 'production', title: '批量制作' },
  { key: 'edit', title: '剪辑与字幕' },
  { key: 'delivery', title: '成片交付' },
] as const
type Section = (typeof sections)[number]['key']
const legacySections: Record<string, string> = {
  library: 'cast',
  timeline: 'edit',
  jobs: 'production',
}
const section = computed(() => {
  const requested = String(route.query.section ?? 'brief')
  return (
    sections.find((s) => s.key === (legacySections[requested] ?? requested))
      ?.key ?? 'brief'
  )
})
const jobFilter = ref('all')
const jobPage = ref(1)
const jobPageSize = ref(10)
const visibleJobs = computed(() =>
  (p.value?.jobs ?? []).filter((job) => {
    if (section.value === 'delivery') return job.kind === 'export'
    if (jobFilter.value === 'attention')
      return ['failed', 'unknown', 'paused', 'unaccepted'].includes(job.state)
    if (jobFilter.value === 'active')
      return ['queued', 'submitting', 'polling', 'downloading'].includes(
        job.state,
      )
    if (jobFilter.value === 'ready') return job.state === 'ready'
    return true
  }),
)
const pageJobs = computed(() =>
  visibleJobs.value.slice(
    (jobPage.value - 1) * jobPageSize.value,
    jobPage.value * jobPageSize.value,
  ),
)
watch([jobFilter, section, jobPageSize], () => {
  jobPage.value = 1
})
watch(
  () => visibleJobs.value.length,
  (length) => {
    jobPage.value = Math.min(
      jobPage.value,
      Math.max(1, Math.ceil(length / jobPageSize.value)),
    )
  },
)
const nextStep = computed(() => {
  const pending = preparation.value?.stages.find(
    (s) => !['confirmed', 'skipped'].includes(s.status),
  )
  return pending
    ? { key: pending.key, label: pending.title }
    : p.value
      ? nextFoundationStep(p.value)
      : null
})
const activePreparation = computed(() =>
  preparation.value?.stages.find((s) => s.key === section.value),
)
async function preparedUpdate() {
  await run(reload)
  refreshPreparation()
}
async function collectionSaved() {
  collection.value = undefined
  await preparedUpdate()
}
function confirmedStage() {
  refreshPreparation()
  const next: Record<string, Section> = {
    script: 'cast',
    cast: 'storyboard',
    storyboard: 'sample',
    sample: 'production',
  }
  void router.push(sectionLink(next[section.value] ?? 'brief'))
}
function locatePreparation(target: string) {
  if (p.value?.document.shots.some((s) => s.id === target))
    selected.value = target
  else castWorkspace.value?.locate(target)
}
const readonly = computed(
  () =>
    p.value?.lifecycle === 'archived' ||
    !auth.can('studio.projects.write') ||
    episodeContext.locked.value,
)
const sectionLink = (key: Section) => ({
  path: route.path,
  query: { ...route.query, section: key },
})
// 首次进入再挂载表单，切换步骤时保留尚未发出的导演指令、素材草稿与镜头选择。
const visited = ref(new Set<Section>())
watch(section, (active) => visited.value.add(active), { immediate: true })
const selected = computed({
  get: () => (typeof route.query.shot === 'string' ? route.query.shot : ''),
  set: (shot: string) => {
    void router.replace({
      path: route.path,
      query: { ...route.query, shot: shot || undefined },
    })
  },
})
const drag = ref(-1),
  planOpen = ref(false),
  plan = ref<Generation>()
const shot = computed({
  get: () =>
    p.value?.document.shots.find((s) => s.id === selected.value) ??
    p.value?.document.shots[0],
  set: (s: Shot | undefined) => {
    if (s && p.value) {
      const index = p.value.document.shots.findIndex((i) => i.id === s.id)
      if (index >= 0) p.value.document.shots[index] = s
    }
  },
})
function reference(shot: Shot) {
  return [...shot.references, ...shot.lines.map((l) => l.role)].find((id) =>
    linked.value.some(
      (a) =>
        a.id === id &&
        a.fileId &&
        ['character', 'scene', 'prop', 'image'].includes(a.kind),
    ),
  )
}
const hasReference = (shot: Shot) => Boolean(reference(shot))
const allLines = computed(
  () => p.value?.document.shots.flatMap((s) => s.lines) ?? [],
)
const shotIndex = computed(
  () => p.value?.document.shots.findIndex((s) => s.id === shot.value?.id) ?? -1,
)
function shiftSelection(offset: number) {
  if (p.value && shotIndex.value >= 0)
    moveShot(p.value.document, shotIndex.value, shotIndex.value + offset)
}
const planShots = computed(
  () =>
    p.value?.document.shots.filter((s) => plan.value?.shots.includes(s.id)) ??
    [],
)
async function confirmChange(message: string, confirmButtonText: string) {
  try {
    await ElMessageBox.confirm(message, '确认操作', {
      type: 'warning',
      confirmButtonText,
      cancelButtonText: '取消',
      closeOnClickModal: false,
    })
    return true
  } catch {
    return false
  }
}
const briefDraft = ref(false)
const directorDraft = ref(false),
  materialDraft = ref(false)
const unsaved = computed(
  () =>
    dirty.value ||
    directorDraft.value ||
    textEditorDraft.value ||
    materialDraft.value ||
    briefDraft.value,
)
const leaving = ref(false)
let decideLeave: ((allowed: boolean) => void) | undefined
function settleLeave(allowed: boolean) {
  const finish = decideLeave
  decideLeave = undefined
  leaving.value = false
  finish?.(allowed)
}
function leaveProject() {
  if (!unsaved.value) return true
  if (busy.value || leaving.value) return false
  leaving.value = true
  return new Promise<boolean>((resolve) => {
    decideLeave = resolve
  })
}
/** 导演输入和素材表单有各自的提交动作，保存工程不能代替提交或悄悄丢掉草稿。 */
async function saveAndLeave() {
  if (
    directorDraft.value ||
    materialDraft.value ||
    briefDraft.value ||
    stale.value
  )
    return
  if (await run(() => save())) settleLeave(!unsaved.value)
}
onScopeDispose(() => settleLeave(false))
onBeforeRouteLeave(leaveProject)
onBeforeRouteUpdate(
  (to, from) => to.params.project === from.params.project || leaveProject(),
)
function protectDraft(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}
watch(unsaved, (hasDraft) => {
  if (hasDraft) window.addEventListener('beforeunload', protectDraft)
  else window.removeEventListener('beforeunload', protectDraft)
})
onScopeDispose(() => window.removeEventListener('beforeunload', protectDraft))
async function reloadDraft() {
  if (
    !dirty.value ||
    (await confirmChange('载入最新工程会放弃本地草稿，继续？', '载入最新工程'))
  )
    await run(reload)
}
async function restoreVersion(revision: number) {
  if (
    !p.value ||
    !(await confirmChange(
      '将当前工程恢复到版本 ' + revision + '？',
      '恢复此版',
    ))
  )
    return
  await run(async () => {
    await studioApi.restore(id, p.value!.revision, revision)
    await reload()
  })
}
const previewJob = ref('')
async function adoptCandidate(candidate: string) {
  const target = shot.value
  const next = p.value?.jobs.find(
    (job) =>
      job.id === candidate &&
      job.subject === target?.id &&
      job.kind === 'video' &&
      job.state === 'ready',
  )
  if (
    !target ||
    !next ||
    target.candidate === candidate ||
    stale.value ||
    busy.value
  )
    return
  await run(async () => {
    const previous = target.candidate
    const previousAsset = target.videoAssetId
    target.candidate = candidate
    target.videoAssetId = null
    try {
      await save('采用分镜候选')
    } catch (failure) {
      // 失败仅撤回本次选片，其它未保存的编辑应继续保留。
      target.candidate = previous
      target.videoAssetId = previousAsset
      throw failure
    }
  })
}
async function previewTimeline() {
  await run(async () => {
    await save()
    if (!p.value) return
    // 预览复用该修订已经完成或正在渲染的成片。
    const existing = p.value.jobs.find(
      (j) =>
        j.kind === 'export' &&
        j.revision === p.value!.revision &&
        ['ready', 'queued'].includes(j.state),
    )
    if (existing?.state === 'ready') return show(existing)
    const job =
      existing ?? (await submit({ shots: [], lines: [], export: true }))[0]
    if (job) previewJob.value = job.id
  })
}
watch(
  () => p.value?.jobs.find((j) => j.id === previewJob.value),
  async (job) => {
    if (!job || !['ready', 'failed', 'unknown'].includes(job.state)) return
    previewJob.value = ''
    if (job.state !== 'ready') {
      error.value = job.error || '预览未完成，请在制作任务中查看'
      return
    }
    try {
      await show(job)
    } catch (e) {
      error.value = String(e)
    }
  },
)
function newItem() {
  if (!p.value) return
  const s = newShot()
  p.value.document.shots.push(s)
  selected.value = s.id
}
function duplicate(split = false) {
  if (!p.value || !shot.value) return
  try {
    const copy = split
      ? splitShot(
          p.value.document,
          shot.value.id,
          voiceDurations(p.value.jobs, p.value.assets),
        )
      : duplicateShot(p.value.document, shot.value.id)
    if (copy) selected.value = copy.id
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
async function remove() {
  if (
    !p.value ||
    !shot.value ||
    !(await confirmChange('移除此分镜和它的台词？', '移除分镜'))
  )
    return
  removeShot(p.value.document, shot.value.id)
  selected.value = ''
}
function jobSummary(subject: string) {
  const document = p.value?.document
  const index =
    document?.shots.findIndex(
      (s) => s.id === subject || s.lines.some((l) => l.id === subject),
    ) ?? -1
  const target = document?.shots[index]
  if (!target)
    return {
      title: p.value?.assets.find((a) => a.id === subject)?.name ?? '',
      detail: '',
      shotId: '',
    }
  const scene =
    document?.scenes?.find((s) => s.id === target.sceneId)?.title ||
    target.scene ||
    '未命名场景'
  // 标题用于定位镜头，完整生成要求放正文展开，避免长提示词撑高任务卡。
  return {
    title: `镜 ${index + 1} · ${scene.length > 24 ? scene.slice(0, 24) + '…' : scene}`,
    detail: target.lines.find((l) => l.id === subject)?.text ?? target.action,
    shotId: target.id,
  }
}
const productionSummaries = computed(() =>
  Object.fromEntries(
    (p.value?.jobs ?? []).map((job) => [job.id, jobSummary(job.subject)]),
  ),
)
function openJobShot(subject: string) {
  selected.value =
    p.value?.document.shots.find(
      (s) => s.id === subject || s.lines.some((l) => l.id === subject),
    )?.id ?? ''
  void router.push(sectionLink('sample'))
}
function confirmPlan(shots: string[], lines: string[], exporting = false) {
  plan.value = { shots, lines, export: exporting }
  planOpen.value = true
}
const selectedProduction = useProductionPlan(
  'projects',
  () => id,
  async () => {
    await reload()
    if (section.value !== 'sample') await router.push(sectionLink('production'))
  },
)
function generate() {
  const options = plan.value
  if (!options) return
  if (!options.export) {
    void selectedProduction.prepare(async () => {
      await save('制作前保存工程')
      const result = await productionApi.prepare(id, {
        // 预检与导出使用不同契约，不把弹窗的 export 状态透传给制作计划。
        shots: options.shots,
        lines: options.lines,
        revision: p.value!.revision,
        requestKey: createUuid(),
        mode: 'selected',
        video: selectedVideo.value || undefined,
        referenceVideo: selectedReference.value || undefined,
        speech: selectedSpeech.value || undefined,
      })
      planOpen.value = false
      return result
    })
    return
  }
  void run(async () => {
    await submit(options)
    planOpen.value = false
    await router.push(sectionLink('delivery'))
  })
}
async function collect(job: string, kind: string) {
  if (!p.value) return
  const inputValue =
    kind === 'export'
      ? p.value.title
      : kind === 'video'
        ? '镜头候选'
        : '台词配音'
  const answer = await ElMessageBox.prompt('素材名称', '收入项目素材', {
    inputValue,
    inputPattern: /\S/,
    inputErrorMessage: '请输入素材名称',
    confirmButtonText: '保存',
    cancelButtonText: '取消',
  }).catch(() => null)
  if (!answer) return
  await run(async () => {
    const a = await studioApi.collect(id, job, answer.value.trim())
    p.value!.assets.push(a)
    p.value!.document.assets.push(a.id)
    await save('收藏生成素材')
  })
}
/** 卡面区分已经采用的剪辑和最新生成进度，重做一镜时仍显示原选片。 */
const shotCards = computed(() => {
  const latest = new Map<string, string>()
  for (const job of p.value?.jobs ?? []) {
    if (job.kind === 'video' && !latest.has(job.subject))
      latest.set(job.subject, jobStates[job.state] ?? job.state)
  }
  return new Map(
    (p.value?.document.shots ?? []).map((s) => {
      const referenced = new Set([
        ...s.references,
        ...s.lines.map((line) => line.role),
      ])
      const roles = linked.value.filter(
        (a) => a.kind === 'character' && referenced.has(a.id),
      )
      return [
        s.id,
        {
          roles: roles.map((r) => r.name).join('、'),
          status: latest.get(s.id) ?? '待生成',
          missingVoice: s.lines.some(
            (line) =>
              !line.voice && !roles.find((r) => r.id === line.role)?.voice,
          ),
        },
      ]
    }),
  )
})
</script>
<template>
  <section class="page management-page studio-editor">
    <header class="studio-project-header">
      <PageHeader :title="p?.title ?? '作品工作台'" />
      <div class="toolbar studio-project-actions">
        <router-link to="/entertainment" class="studio-back"
          ><AppIcon name="arrow-left" />作品首页</router-link
        >
        <template v-if="p">
          <span class="toolbar-spacer" />
          <span class="studio-meta"
            >{{
              p.aspectWidth && p.aspectHeight
                ? `${p.aspectWidth}:${p.aspectHeight}`
                : '画幅待定'
            }}
            ·
            {{
              p.targetDurationMs
                ? `${p.targetDurationMs / 1000} 秒目标`
                : '时长待定'
            }}</span
          >
          <el-button v-if="!readonly" @click="openDirector()"
            >导演助手</el-button
          >
          <span class="studio-meta" role="status"
            >版本 {{ p.revision
            }}{{
              saving
                ? ' · 保存中'
                : dirty
                  ? ' · 有未保存编辑'
                  : notice
                    ? ' · ' + notice
                    : ''
            }}</span
          >
          <el-button v-if="stale" :disabled="busy" @click="reloadDraft"
            >载入最新工程</el-button
          >
          <el-button
            type="primary"
            :disabled="readonly || busy || saving || !dirty || stale"
            @click="run(() => save())"
            >保存工程</el-button
          >
        </template>
      </div>
    </header>
    <SeriesEpisodeContext
      v-if="episodeContext.context.value"
      :context="episodeContext.context.value"
      :project="id"
      @open="
        router.push({ path: '/entertainment/' + $event, query: { section } })
      "
    />
    <el-alert
      v-if="episodeContext.error.value"
      :title="'暂时无法读取作品归属，编辑已暂停。' + episodeContext.error.value"
      type="error"
      :closable="false"
      ><el-button @click="episodeContext.reload"
        >重试归属检查</el-button
      ></el-alert
    >
    <ResourceStatus
      v-if="!p"
      :loading="busy"
      :error="error"
      @retry="run(reload)"
    />
    <el-alert
      v-else-if="error && !planOpen"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <template v-if="p">
      <el-alert
        v-if="readonly"
        :title="
          p.lifecycle === 'archived'
            ? '作品已归档，恢复后可继续编辑。'
            : episodeContext.context.value?.archived
              ? '这是已移除或拆合前的历史分集，工程与成果以只读方式保留。'
              : episodeContext.context.value?.locked
                ? '本集已锁定。请回到整剧的分集编排中解锁后再修改。'
                : episodeContext.loading.value
                  ? '正在检查作品归属与编辑状态。'
                  : '当前账号可查看作品，编辑需要创作权限。'
        "
        type="info"
        :closable="false"
      />
      <div
        v-else-if="nextStep && section === 'brief'"
        class="toolbar toolbar-panel"
      >
        <span>继续创作</span
        ><router-link
          :to="{
            path: route.path,
            query: { ...route.query, section: nextStep.key },
          }"
          >{{ nextStep.label }} →</router-link
        ><router-link v-if="p.proposal" :to="sectionLink('storyboard')"
          >导演草案待审阅</router-link
        >
      </div>
      <StudioStageNav
        :sections="sections"
        :active="section"
        :states="preparation?.stages ?? []"
      />
      <el-alert
        v-if="preparationError"
        :title="'阶段检查暂不可用：' + preparationError"
        type="error"
        :closable="false"
      />
      <StudioProjectBrief
        v-if="visited.has('brief')"
        v-show="section === 'brief'"
        :project="p"
        :disabled="readonly || busy || saving || dirty"
        @draft="briefDraft = $event"
        @saved="run(reload)"
      />
      <div
        v-if="visited.has('script')"
        v-show="section === 'script'"
        class="studio-stage"
      >
        <StudioScript
          ref="scriptWorkspace"
          v-model="p.document"
          :disabled="readonly || textEditorBusy"
          :brief="p.brief"
          :can-direct="canDirect"
          :has-proposal="!!p.proposal"
          :assets="linked"
          :project="id"
          :selected-scene="
            typeof route.query.scene === 'string'
              ? route.query.scene
              : undefined
          "
          @direct="openDirector"
          @review="reviewProposal"
          @shot="openSceneShot"
          @assist="openTextEditor"
          @pick-scene="
            (scene) =>
              pickAsset({
                title: '为' + scene.title + '选择场景',
                kinds: ['scene'],
                target: { kind: 'scene', sceneId: scene.id },
              })
          "
        />
      </div>
      <div
        v-if="p.proposal && (section === 'script' || section === 'storyboard')"
        ref="proposalPanel"
        tabindex="-1"
        aria-label="导演方案审阅"
      >
        <StudioProposalReview
          :project="p"
          :readonly="readonly"
          :save="save"
          @reviewed="preparedUpdate"
        />
      </div>
      <StudioScriptReview
        v-if="section === 'script'"
        :project="p"
        :state="activePreparation"
        :readonly="readonly"
        :pending="dirty || saving || preparation?.revision !== p.revision"
        :save="save"
        @confirmed="confirmedStage"
        @write="scriptWorkspace?.focusScript()"
        @proposal="reviewProposal"
      />
      <StudioCastWorkspace
        v-if="visited.has('cast')"
        v-show="section === 'cast'"
        ref="castWorkspace"
        :project="p"
        :catalog="catalog"
        :readonly="readonly"
        :save="save"
        :import-asset="importAsset"
        :apply-library-result="applyLibraryResult"
        @updated="preparedUpdate"
      >
        <StudioLibrary
          :project="p"
          :readonly="readonly"
          :voices="voices"
          :busy="busy"
          :create="(a, link) => run(() => asset(a, link))"
          @draft="materialDraft = $event"
          @favorite="collectAsset"
          @link="
            (key) => {
              const source = p!.assets.find((item) => item.id === key)
              if (source)
                run(async () => {
                  await importAsset(source)
                })
            }
          "
        />
      </StudioCastWorkspace>
      <StudioSampleWorkspace
        v-if="section === 'sample'"
        :project="p"
        :readonly="readonly"
        :can-generate="auth.can('models.use')"
        :busy="busy"
        :selected="selected"
        :reference="reference"
        @select="selected = $event"
        @generate="confirmPlan"
        @adopt="adoptCandidate"
      />
      <div v-if="section === 'storyboard'" class="studio-stage">
        <div class="toolbar">
          <el-button @click="animaticOpen = !animaticOpen">{{
            animaticOpen ? '收起预演' : '查看分镜预演'
          }}</el-button
          ><span class="studio-meta"
            >静态画面与已采用配音先看节奏，再进入代表镜头试做。</span
          >
        </div>
        <StudioAnimatic v-if="animaticOpen" :project="p" />
        <div v-if="!readonly" class="studio-toolbar studio-board-actions">
          <el-button type="primary" @click="newItem">添加分镜</el-button>
          <div class="toolbar" role="group" aria-label="当前镜头操作">
            <el-button :disabled="!shot" @click="duplicate()">复制</el-button
            ><el-button :disabled="shotIndex <= 0" @click="shiftSelection(-1)"
              >前移</el-button
            ><el-button
              :disabled="
                shotIndex < 0 || shotIndex >= p.document.shots.length - 1
              "
              @click="shiftSelection(1)"
              >后移</el-button
            ><el-button
              :disabled="
                !shot ||
                (shot.videoAssetId
                  ? (shot.trimEnd ?? shot.duration) - shot.trimStart
                  : shot.duration) < 2000
              "
              @click="duplicate(true)"
            >
              等分镜头</el-button
            ><el-button :disabled="!shot" @click="remove">移除</el-button>
          </div>
          <el-button
            v-if="auth.can('models.use')"
            :disabled="busy || !p.document.shots.length"
            @click="
              confirmPlan(
                p.document.shots.map((s) => s.id),
                allLines.map((l) => l.id),
              )
            "
          >
            批量生成
          </el-button>
        </div>
        <StudioWorkspace :selected="shot?.id">
          <template #rail>
            <ScrollPanel
              as="aside"
              class="panel studio-panel studio-rail"
              label="分镜目录"
            >
              <template #header><h2>分镜顺序</h2></template>
              <p v-if="!p.document.shots.length" class="studio-meta">
                点击「添加分镜」开始设计第一个镜头。
              </p>
              <button
                v-for="(s, i) in p.document.shots"
                :key="s.id"
                :draggable="!readonly"
                :aria-pressed="s.id === shot?.id"
                class="studio-shot"
                @dragstart="drag = i"
                @dragover.prevent
                @drop.prevent="!readonly && moveShot(p.document, drag, i)"
                @click="selected = s.id"
              >
                <span class="studio-rail-image"
                  ><StudioMedia
                    v-if="s.candidate"
                    :project="id"
                    :job="s.candidate"
                    kind="video"
                    lazy
                  /><StudioMedia
                    v-else-if="auth.can('files.read') && reference(s)"
                    :project="id"
                    :asset="reference(s)"
                    kind="image"
                    lazy
                  /><b>{{ String(i + 1).padStart(2, '0') }}</b></span
                ><span class="studio-rail-label"
                  ><strong
                    >镜 {{ String(i + 1).padStart(2, '0') }} ·
                    {{
                      p.document.scenes?.find((scene) => scene.id === s.sceneId)
                        ?.title ||
                      s.scene ||
                      '场景待定'
                    }}</strong
                  ><span class="studio-rail-summary">{{
                    s.action || '待填写动作'
                  }}</span
                  ><small
                    >{{ s.duration / 1000 }} 秒 ·
                    {{ shotCards.get(s.id)?.roles || '无角色' }} ·
                    {{ shotCards.get(s.id)?.status
                    }}{{ s.candidate ? ' · 已采用候选' : '' }}
                    <span v-if="shotCards.get(s.id)?.missingVoice">
                      · 待选音色</span
                    ></small
                  ></span
                >
              </button>
            </ScrollPanel>
          </template>
          <StudioShotMonitor
            v-if="shot"
            :key="shot.id"
            :shot="shot"
            :aspect-width="p.aspectWidth"
            :aspect-height="p.aspectHeight"
            :project="id"
            :jobs="p.jobs"
            :reference="auth.can('files.read') ? reference(shot) : undefined"
            :position="p.document.shots.findIndex((s) => s.id === shot?.id) + 1"
            :busy="busy || stale || readonly"
            @adopt="adoptCandidate"
          />
          <template #inspector
            ><ShotEditor
              v-if="shot"
              :project="id"
              :model-value="shot"
              :assets="linked"
              :jobs="p.jobs"
              :voices="voices"
              :scenes="p.document.scenes ?? []"
              :readonly="readonly"
              :can-generate="auth.can('models.use') && !busy && !readonly"
              @update:model-value="(s) => (shot = s)"
              @preview="(j) => run(() => show(j))"
              @generate="confirmPlan"
              @pick="pickAsset"
          /></template>
        </StudioWorkspace>
        <StudioFilmstrip
          v-if="p.document.shots.length"
          :project="id"
          :shots="p.document.shots"
          :selected="shot?.id"
          :reference="
            (s) => (auth.can('files.read') ? reference(s) : undefined)
          "
          @select="selected = $event"
        />
        <StudioBoardPreparation
          v-if="shot"
          :key="shot.id"
          :project="p"
          :shot="shot"
          :catalog="catalog"
          :readonly="
            readonly ||
            !auth.can('models.use') ||
            !auth.can('studio.assets.write')
          "
          :save="save"
          @updated="preparedUpdate"
        />
      </div>
      <StudioStageReview
        v-if="activePreparation && section !== 'script'"
        :key="activePreparation.key"
        :state="activePreparation"
        :project="p"
        :readonly="readonly"
        :save="save"
        @confirmed="confirmedStage"
        @locate="locatePreparation"
      />
      <StudioTimeline
        v-if="section === 'edit'"
        v-model="p"
        :selected="shot?.id"
        :busy="busy || readonly"
        :readonly="readonly"
        :preparing="!!previewJob"
        @select="selected = $event"
        @preview="previewTimeline"
        @restore="restoreVersion"
        @export="confirmPlan([], [], true)"
        @pick="pickAsset"
      />
      <section
        v-if="section === 'production' || section === 'delivery'"
        class="panel studio-panel"
      >
        <h2>
          {{ section === 'delivery' ? '本作品的成片交付' : '本作品的制作任务' }}
        </h2>
        <StudioProductionWorkspace
          v-if="section === 'production' && !readonly && auth.can('models.use')"
          :project="p"
          :catalog="catalog"
          :disabled="busy || saving || stale"
          :save="save"
          @updated="run(reload)"
        />
        <div v-if="section === 'delivery' && !readonly" class="toolbar">
          <el-button
            :disabled="busy || !p.document.shots.length"
            @click="confirmPlan([], [], true)"
            >导出当前修订</el-button
          ><router-link :to="sectionLink('edit')">返回剪辑检查</router-link>
        </div>
        <div v-if="section === 'production'" class="toolbar studio-job-toolbar">
          <h3>制作记录</h3>
          <el-select v-model="jobFilter" aria-label="筛选制作记录"
            ><el-option value="all" label="全部任务" /><el-option
              value="attention"
              label="需要处理" /><el-option
              value="active"
              label="正在制作" /><el-option value="ready" label="已完成"
          /></el-select>
        </div>
        <p v-if="!visibleJobs.length" class="studio-meta">
          {{
            section === 'delivery'
              ? '尚未导出成片，完成剪辑后可导出当前工程。'
              : '当前范围没有制作任务。'
          }}
        </p>
        <article v-for="j in pageJobs" :key="j.id">
          <StudioMedia
            v-if="section === 'delivery' && j.state === 'ready'"
            class="delivery-thumbnail"
            :project="id"
            :job="j.id"
            kind="video"
            lazy
          />
          <h3>
            {{ jobKinds[j.kind]
            }}<span v-if="productionSummaries[j.id]?.title">
              · {{ productionSummaries[j.id]?.title }}</span
            >
            · 版本 {{ j.revision }}
          </h3>
          <ExpandableText
            v-if="productionSummaries[j.id]?.detail"
            :text="productionSummaries[j.id]!.detail"
            label="任务内容"
            :lines="2"
          />
          <span class="studio-meta"
            >{{ jobStates[j.state] ?? j.state
            }}<template v-if="j.duration">
              · {{ j.duration / 1000 }} 秒</template
            ></span
          ><ExpandableText
            v-if="j.error"
            :text="j.error"
            label="失败详情"
            :lines="2"
          />
          <div class="studio-actions">
            <el-button
              v-if="j.kind !== 'export' && productionSummaries[j.id]?.shotId"
              link
              @click="openJobShot(j.subject)"
              >查看对应镜头</el-button
            >
            <StudioRecovery
              :label="productionSummaries[j.id]?.title"
              :project="id"
              :job="j"
              @recovered="(result) => Object.assign(j, result)"
            />
            <el-button v-if="j.state === 'ready'" @click="run(() => show(j))">
              预览
            </el-button>
            <el-button
              v-if="j.state === 'ready'"
              @click="run(() => show(j, true))"
            >
              下载
            </el-button>
            <el-button
              v-if="
                j.state === 'ready' &&
                auth.can('files.write') &&
                auth.can('files.read')
              "
              :disabled="busy"
              @click="collect(j.id, j.kind)"
            >
              收入项目素材
            </el-button>
          </div>
        </article>
        <ManagementPagination
          v-model:current-page="jobPage"
          v-model:page-size="jobPageSize"
          :total="visibleJobs.length"
          :page-sizes="[10, 20, 50]"
        />
      </section>
      <StudioMediaPreview
        v-if="preview"
        :url="preview.url"
        :kind="preview.kind"
        :revision="preview.revision"
        @close="preview = null"
      />
      <StudioAssetPicker
        v-if="assetPicker"
        :project="p"
        :title="assetPicker.title"
        :kinds="assetPicker.kinds"
        :resolve="resolveAsset"
        @selected="assetPicker = undefined"
        @close="assetPicker = undefined"
      />
      <StudioCollectionDialog
        v-if="collection"
        :asset="collection"
        @saved="collectionSaved"
        @close="collection = undefined"
      />
      <ProductionPlanDialog
        v-if="selectedProduction.plan.value"
        v-model="selectedProduction.open.value"
        :plan="selectedProduction.plan.value"
        :busy="selectedProduction.busy.value"
        :error="selectedProduction.error.value"
        @confirm="selectedProduction.confirm"
      />
      <GenerationDialog
        v-if="plan"
        v-model="planOpen"
        v-model:video="selectedVideo"
        v-model:reference-video="selectedReference"
        v-model:speech="selectedSpeech"
        :plan="plan"
        :revision="p.revision"
        :shots="planShots"
        :lines="allLines.filter((line) => plan!.lines.includes(line.id))"
        :has-reference="hasReference"
        :catalog="catalog"
        :busy="busy || selectedProduction.busy.value"
        :error="error || selectedProduction.error.value"
        @submit="generate"
      />
      <StudioTextEditor
        :project="p"
        :target="textTarget"
        :active="textEditorOpen"
        :allowed="!readonly && canDirect"
        :save="save"
        :reload="reload"
        @busy="textEditorBusy = $event"
        @draft="textEditorDraft = $event"
        @close="textEditorOpen = false"
      />
      <DirectorChat
        v-if="!readonly"
        :project="id"
        :active="directorOpen"
        :existing="p.sessionId"
        :agents="catalog?.agents ?? []"
        :save="save"
        :reload="reload"
        :revision="p.revision"
        :action="directorAction"
        :brief="p.brief ?? ''"
        :document="p.document"
        :has-proposal="!!p.proposal"
        :context="`${sections.find((s) => s.key === section)?.title ?? ''}${shot ? '；选中镜头 ID：' + shot.id : ''}`"
        @draft="directorDraft = $event"
        @review="reviewProposal"
        @update:active="directorOpen = $event"
      />
    </template>
    <el-dialog
      v-model="leaving"
      title="确认操作"
      width="min(440px, 92vw)"
      :close-on-click-modal="false"
      @close="settleLeave(false)"
    >
      <div class="stack">
        <p>作品中还有未保存的内容，确定离开？</p>
        <p
          v-if="directorDraft || materialDraft || briefDraft"
          class="studio-meta"
        >
          制作规格、导演指令或素材表单尚未提交，可以继续编辑，或放弃草稿离开。
        </p>
        <p v-if="stale" class="studio-error">工程已更新，请先处理版本冲突。</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
      </div>
      <template #footer>
        <div class="dialog-actions">
          <el-button :disabled="busy" @click="settleLeave(false)"
            >取消</el-button
          >
          <el-button :disabled="busy" @click="settleLeave(true)"
            >放弃修改</el-button
          >
          <el-button
            type="primary"
            :disabled="
              busy || directorDraft || materialDraft || briefDraft || stale
            "
            @click="saveAndLeave"
            >保存并离开</el-button
          >
        </div>
      </template>
    </el-dialog>
  </section>
</template>
