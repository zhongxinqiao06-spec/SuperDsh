<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { LibraryProjectResult } from '@/types/studio/library'
import { preparationApi } from '@/api/studio/preparation-api'
import { useAuthStore } from '@/store/modules/auth-store'
import type {
  StudioAsset,
  StudioProject,
  StudioCatalog,
  Job,
} from '@/types/studio/studio'
import { assetKinds, jobStates } from '@/utils/studio/media-labels'
import ExpandableText from '@/components/base/ExpandableText.vue'
import AppDrawer from '@/components/overlay/AppDrawer.vue'
import StudioMedia from '../StudioMedia.vue'
import PreparationGenerationDialog from './PreparationGenerationDialog.vue'
import StudioAssetPicker from '../library/StudioAssetPicker.vue'
import StudioCollectionDialog from '../library/StudioCollectionDialog.vue'
import StudioAssetDetail from '../library/StudioAssetDetail.vue'
import StudioLibraryUpdateDialog from '../library/StudioLibraryUpdateDialog.vue'
import { hasLibraryUpdates, libraryPath } from '@/utils/studio/library'

/** 设定卡直接管理造型、音色和候选；完整素材维护仍复用已有版本表单。 */
const props = defineProps<{
  project: StudioProject
  catalog?: StudioCatalog
  readonly: boolean
  save: () => Promise<void>
  importAsset: (asset: StudioAsset) => Promise<StudioAsset>
  applyLibraryResult: (result: LibraryProjectResult) => void
}>()
const emit = defineEmits<{ updated: [] }>()
const auth = useAuthStore()
const category = ref<StudioAsset['kind']>('character'),
  libraryOpen = ref(false),
  selected = ref<StudioAsset>(),
  busy = ref(false),
  error = ref('')
const generation = ref<{ kind: 'reference' | 'voice'; asset: StudioAsset }>()
const picking = ref(false),
  collecting = ref<StudioAsset>(),
  inspecting = ref<StudioAsset>(),
  updating = ref<StudioAsset>()
const assets = computed(() =>
  props.project.assets.filter(
    (a) =>
      props.project.document.assets.includes(a.id) && a.kind === category.value,
  ),
)
async function collect(asset: StudioAsset) {
  try {
    await props.save()
    collecting.value = asset
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
function collected() {
  collecting.value = undefined
  ElMessage.success('已保存到素材库，本片内容保持不变')
  emit('updated')
}
function picked() {
  picking.value = false
  emit('updated')
}
function applied(result: LibraryProjectResult) {
  props.applyLibraryResult(result)
  updating.value = undefined
  emit('updated')
}
const current = computed(
  () =>
    selected.value &&
    (props.project.assets.find(
      (a) =>
        a.id === selected.value!.id &&
        props.project.document.assets.includes(a.id),
    ) ??
      props.project.assets.find(
        (a) =>
          a.family === selected.value!.family &&
          props.project.document.assets.includes(a.id),
      )),
)
const candidates = computed(() =>
  props.project.jobs.filter(
    (j) =>
      j.family === current.value?.family &&
      (j.purpose === 'reference' || j.purpose === 'voice'),
  ),
)
const canCreate = computed(
  () =>
    !props.readonly &&
    auth.can('studio.assets.write') &&
    auth.can('models.use'),
)
/** 检查清单定位到对应分类并打开该设定的候选，避免按钮点击后无反馈。 */
function locate(identity: string) {
  const asset = props.project.assets.find((item) => item.id === identity)
  if (!asset) return
  category.value = asset.kind
  selected.value = asset
}
function inspect(identity: string) {
  const asset = props.project.assets.find((item) => item.id === identity)
  if (asset) {
    category.value = asset.kind
    inspecting.value = asset
  }
}
defineExpose({ locate, inspect })
function submitted() {
  selected.value = generation.value?.asset
  generation.value = undefined
  emit('updated')
}
function dialogue(asset: StudioAsset) {
  return (
    props.project.document.shots
      .flatMap((s) => s.lines)
      .find((l) => l.role === asset.id)?.text ?? ''
  )
}
let attempt: { signature: string; key: string } | undefined
async function adopt(job: Job) {
  if (!current.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await props.save()
    const body = {
      revision: props.project.revision,
      job: job.id,
      target: current.value.id,
    }
    const signature = JSON.stringify(body)
    if (attempt?.signature !== signature)
      attempt = { signature, key: createUuid() }
    await preparationApi.adopt(props.project.id, {
      ...body,
      requestKey: attempt.key,
    })
    attempt = undefined
    emit('updated')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="cast-workspace">
    <div class="toolbar toolbar-panel">
      <el-radio-group v-model="category" aria-label="设定分类"
        ><el-radio-button value="character">人物与声音</el-radio-button
        ><el-radio-button value="scene">场景</el-radio-button
        ><el-radio-button value="prop">道具</el-radio-button></el-radio-group
      ><span class="toolbar-spacer" /><el-button
        v-if="!readonly"
        @click="picking = true"
        >从素材库选用</el-button
      ><el-button @click="libraryOpen = true">{{
        readonly ? '查看本片素材' : '新建或编辑本片设定'
      }}</el-button>
    </div>
    <div v-if="!assets.length" class="preparation-empty panel">
      <h2>
        先确定{{
          category === 'character'
            ? '谁在故事里'
            : category === 'scene'
              ? '故事发生在哪里'
              : '镜头里需要哪些道具'
        }}
      </h2>
      <p>
        可以从个人库复用已有设定，也可以为本片新增。没有人物或对白的作品不必添加角色。
      </p>
      <div class="toolbar">
        <el-button v-if="!readonly" type="primary" @click="picking = true"
          >从素材库选用</el-button
        ><el-button v-if="!readonly" @click="libraryOpen = true"
          >为本片新建</el-button
        >
      </div>
    </div>
    <div class="cast-card-grid">
      <article v-for="asset in assets" :key="asset.id" class="cast-card panel">
        <div class="cast-visual">
          <StudioMedia
            v-if="asset.fileId && auth.can('files.read')"
            :project="project.id"
            :asset="asset.id"
            kind="image"
            lazy
          />
          <div v-else class="cast-placeholder">
            <span>{{ assetKinds[asset.kind] }}</span
            ><strong>{{ asset.name }}</strong
            ><small>上传参考图或生成一个造型</small>
          </div>
        </div>
        <div class="cast-card-body">
          <div class="toolbar">
            <h3>{{ asset.name }}</h3>
            <span class="toolbar-spacer" /><el-tag size="small"
              >版本 {{ asset.version ?? 1 }}</el-tag
            >
          </div>
          <ExpandableText
            :text="asset.description || '尚未填写外观或场景设定'"
            label="设定"
            markdown
            :lines="3"
          />
          <p v-if="asset.kind === 'character'" class="studio-meta">
            声音 ·
            {{
              asset.voicePreviewJob
                ? '已采用试听'
                : asset.voice
                  ? '已选音色，待试听'
                  : '尚未选择'
            }}
          </p>
          <details v-if="asset.voice">
            <summary class="studio-meta">查看音色标识</summary>
            <span class="studio-meta">{{ asset.voice }}</span>
          </details>
          <StudioMedia
            v-if="asset.voicePreviewAssetId"
            :project="null"
            :asset="asset.voicePreviewAssetId"
            kind="audio"
            controls
          />
          <StudioMedia
            v-else-if="asset.voicePreviewJob"
            :project="project.id"
            :job="asset.voicePreviewJob"
            kind="audio"
            controls
          />
          <p v-if="asset.origin" class="studio-meta">
            已关联素材库 ·
            <router-link
              :to="{
                path: libraryPath(asset.kind),
                query: { asset: asset.origin.currentVersionId },
              }"
              >{{ asset.origin.name }}</router-link
            ><span v-if="asset.variantName"> · {{ asset.variantName }}</span>
          </p>
          <div class="toolbar cast-card-actions">
            <el-button
              v-if="canCreate"
              @click="generation = { kind: 'reference', asset }"
              >生成参考图</el-button
            ><el-button
              v-if="canCreate && asset.kind === 'character'"
              @click="generation = { kind: 'voice', asset }"
              >试听选音色</el-button
            ><el-button @click="selected = asset">候选与版本</el-button>
            <el-button
              v-if="!readonly && auth.can('studio.assets.write')"
              :aria-label="
                asset.name + (asset.origin ? '存回素材库' : '收藏到素材库')
              "
              @click="collect(asset)"
              >{{ asset.origin ? '存回素材库' : '收藏到素材库' }}</el-button
            >
            <el-button
              v-if="
                asset.origin && !readonly && auth.can('studio.assets.write')
              "
              :type="hasLibraryUpdates(asset) ? 'primary' : 'default'"
              @click="updating = asset"
              >{{
                hasLibraryUpdates(asset) ? '比较库内更新' : '检查库内更新'
              }}</el-button
            >
          </div>
        </div>
      </article>
    </div>
    <el-alert
      v-if="error && !selected"
      :title="error"
      type="error"
      :closable="false"
    />
    <StudioAssetPicker
      v-if="picking"
      :project="project"
      :title="'为本片选择' + assetKinds[category]"
      :kinds="[category]"
      :resolve="importAsset"
      personal-first
      @selected="picked"
      @close="picking = false"
    />
    <StudioCollectionDialog
      v-if="collecting"
      :asset="collecting"
      @saved="collected"
      @close="collecting = undefined"
    />
    <StudioAssetDetail
      v-if="inspecting"
      :asset="inspecting"
      @close="inspecting = undefined"
    />
    <StudioLibraryUpdateDialog
      v-if="updating"
      :project="project.id"
      :asset="updating"
      :save="save"
      @close="updating = undefined"
      @applied="applied"
    />
    <AppDrawer
      v-model="libraryOpen"
      title="项目素材与个人库"
      size="min(1080px, 96vw)"
      ><slot
    /></AppDrawer>
    <AppDrawer
      :model-value="!!selected"
      :title="current ? current.name + ' · 候选与版本' : '候选与版本'"
      size="min(780px, 96vw)"
      @update:model-value="(value) => !value && (selected = undefined)"
    >
      <div v-if="current" class="stack">
        <p>
          预览不会改变作品。采用时只更新本片中当前设定的引用，台词和已生成的视频继续保留。
        </p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <p v-if="!candidates.length" class="studio-meta">
          暂无生成候选。先生成参考图，或试听一种音色。
        </p>
        <article
          v-for="job in candidates"
          :key="job.id"
          class="panel preparation-candidate"
        >
          <div class="toolbar">
            <strong>{{
              job.purpose === 'voice' ? '音色 · ' + job.voice : '造型候选'
            }}</strong
            ><span class="toolbar-spacer" /><el-tag>{{
              jobStates[job.state] ?? job.state
            }}</el-tag>
          </div>
          <p v-if="job.sourceVersion !== current.id" class="studio-meta">
            基于此前设定生成；采用时保留当前文字设定与其他素材。
          </p>
          <StudioMedia
            v-if="job.state === 'ready'"
            :project="project.id"
            :job="job.id"
            :kind="job.kind === 'image' ? 'image' : 'audio'"
            controls
          />
          <p v-if="job.text">{{ job.text }}</p>
          <p v-if="job.error" role="alert">{{ job.error }}</p>
          <el-button
            v-if="
              job.state === 'ready' &&
              !readonly &&
              auth.can('studio.assets.write')
            "
            type="primary"
            :disabled="busy || job.id === current.voicePreviewJob"
            @click="adopt(job)"
            >{{
              job.id === current.voicePreviewJob
                ? '已采用音色'
                : job.purpose === 'voice'
                  ? '采用此音色'
                  : '采用此画面'
            }}</el-button
          >
        </article>
      </div>
    </AppDrawer>
    <PreparationGenerationDialog
      v-if="generation"
      :project="project"
      :catalog="catalog"
      :target="generation.asset.id"
      :kind="generation.kind"
      :title="
        generation.kind === 'voice'
          ? generation.asset.name + ' · 试听音色'
          : generation.asset.name + ' · 生成参考图'
      "
      :initial-voice="generation.asset.voice"
      :initial-text="dialogue(generation.asset)"
      :save="save"
      @close="generation = undefined"
      @submitted="submitted"
    />
  </section>
</template>
