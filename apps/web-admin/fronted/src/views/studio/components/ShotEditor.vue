<script setup lang="ts">
import type { StoryScene } from '@/types/studio/foundation'
import type { Dialogue, Job, Shot, StudioAsset } from '@/types/studio/studio'
import { ref } from 'vue'
import { newId } from '@/utils/studio/storyboard'
import LongTextField from '@/components/form/LongTextField.vue'
import DurationField from '@/components/form/DurationField.vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import StudioReferenceGroup from './library/StudioReferenceGroup.vue'
import StudioMedia from './StudioMedia.vue'
import type { AssetUseTarget } from '@/utils/studio/asset-use'
const shot = defineModel<Shot>({ required: true })
// 分组只控制展示；所有字段仍直接编辑父级镜头草稿，切页签不会丢失输入。
const tab = ref('picture')
const props = defineProps<{
  scenes?: StoryScene[]
  readonly?: boolean
  project: string
  assets: StudioAsset[]
  jobs: Job[]
  voices: string[]
  canGenerate: boolean
}>()
const emit = defineEmits<{
  preview: [Job]
  generate: [string[], string[]]
  pick: [
    value: {
      title: string
      kinds: StudioAsset['kind'][]
      target: AssetUseTarget
    },
  ]
}>()
const referenceGroups: { kind: StudioAsset['kind']; label: string }[] = [
  { kind: 'character', label: '出场角色与造型' },
  { kind: 'prop', label: '本镜道具' },
  { kind: 'image', label: '其他视觉参考' },
]
function pickReference(kind: StudioAsset['kind'], label: string) {
  emit('pick', {
    title: '为当前镜头选择' + label,
    kinds: [kind],
    target: { kind: 'reference', shotId: shot.value.id },
  })
}
function removeReference(id: string) {
  shot.value.references = shot.value.references.filter((value) => value !== id)
}
function adoptVoice(line: Dialogue, jobId: string) {
  line.audio = jobId
  line.audioAssetId = null
}
const candidates = (id: string) =>
  props.jobs.filter(
    (j) => j.kind === 'speech' && j.subject === id && j.state === 'ready',
  )
function addLine() {
  const role = props.assets.find((a) => a.kind === 'character')
  if (role)
    shot.value.lines.push({
      id: newId(),
      role: role.id,
      text: '',
      voice: '',
      subtitle: null,
      start: 0,
      end: null,
      audio: null,
      volume: 1,
    })
}
</script>
<template>
  <ScrollPanel
    class="panel studio-panel shot-inspector"
    label="镜头设定"
    :reset-key="`${shot.id}:${tab}`"
  >
    <template #header>
      <div class="inspector-header">
        <h2>镜头设定</h2>
      </div>
      <el-tabs v-model="tab" aria-label="镜头设定分组">
        <el-tab-pane label="画面" name="picture" />
        <el-tab-pane label="台词" name="dialogue" />
        <el-tab-pane label="参考素材" name="references" />
      </el-tabs>
    </template>
    <fieldset class="studio-form inspector-fields" :disabled="readonly">
      <template v-if="tab === 'picture'">
        <label class="field"
          >所属场次<select v-model="shot.sceneId" class="native-control">
            <option :value="null">按场景自动建立</option>
            <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
              {{ scene.title }}
            </option>
          </select></label
        >
        <StudioReferenceGroup
          label="本镜场景"
          :removable="!!shot.sceneAssetId"
          :project="project"
          :assets="
            assets.filter(
              (asset) =>
                asset.id ===
                (shot.sceneAssetId ||
                  scenes?.find((scene) => scene.id === shot.sceneId)
                    ?.sceneAssetId),
            )
          "
          :readonly="readonly"
          add-label="选择或更换"
          :empty="
            shot.sceneId
              ? '尚未选择场景，可沿用场次设定或为本镜单独选择。'
              : '选择一个场景作为本镜环境。'
          "
          @choose="
            emit('pick', {
              title: '为当前镜头选择场景',
              kinds: ['scene'],
              target: { kind: 'shot-scene', shotId: shot.id },
            })
          "
          @remove="shot.sceneAssetId = null"
        />
        <p
          v-if="
            !shot.sceneAssetId &&
            scenes?.find((scene) => scene.id === shot.sceneId)?.sceneAssetId
          "
          class="studio-meta"
        >
          沿用所属场次的场景。单独更换只影响这一镜。
        </p>
        <LongTextField
          v-model="shot.action"
          label="动作摘要"
          :min-rows="4"
          :max-rows="8"
          :disabled="readonly"
          expandable
        />
        <div class="studio-grid">
          <label class="field"
            >场景<input v-model="shot.scene" class="native-control" /></label
          ><label class="field"
            >景别<input v-model="shot.camera" class="native-control" /></label
          ><label class="field"
            >构图<input v-model="shot.framing" class="native-control" /></label
          ><label class="field"
            >运镜<input v-model="shot.movement" class="native-control" /></label
          ><DurationField
            :model-value="shot.duration"
            label="时长"
            :min="1000"
            :max="120000"
            :disabled="readonly"
            @update:model-value="shot.duration = $event ?? 1000"
          />
        </div>
      </template>
      <template v-if="tab === 'references'">
        <StudioReferenceGroup
          v-for="group in referenceGroups"
          :key="group.kind"
          :label="group.label"
          :project="project"
          :assets="
            assets.filter(
              (asset) =>
                asset.kind === group.kind && shot.references.includes(asset.id),
            )
          "
          :readonly="readonly"
          add-label="添加"
          @choose="pickReference(group.kind, group.label)"
          @remove="removeReference"
        />
        <StudioReferenceGroup
          v-if="
            assets.some(
              (asset) =>
                asset.kind === 'scene' && shot.references.includes(asset.id),
            )
          "
          label="其他场景参考"
          :project="project"
          :assets="
            assets.filter(
              (asset) =>
                asset.kind === 'scene' && shot.references.includes(asset.id),
            )
          "
          :readonly="readonly"
          @choose="pickReference('scene', '场景参考')"
          @remove="removeReference"
        />
        <p class="studio-meta">
          引用具体造型、场景和道具版本。更换本镜参考不会替换其他镜头。
        </p>
      </template>
      <template v-if="tab === 'dialogue'">
        <h3>角色台词</h3>
        <p v-if="!shot.lines.length" class="studio-meta">
          还没有台词，可以添加角色对白或旁白。
        </p>
        <fieldset
          v-for="(line, i) in shot.lines"
          :key="line.id"
          class="studio-form"
        >
          <legend>第 {{ i + 1 }} 句</legend>
          <label class="field"
            >角色<select v-model="line.role" class="native-control">
              <option
                v-for="a in assets.filter((a) => a.kind === 'character')"
                :key="a.id"
                :value="a.id"
              >
                {{ a.name }}
              </option>
            </select></label
          >
          <LongTextField
            v-model="line.text"
            label="台词"
            :min-rows="2"
            :max-rows="6"
            :disabled="readonly"
          /><label class="field"
            >音色<select v-model="line.voice" class="native-control">
              <option value="">角色默认音色</option>
              <option v-for="v in voices" :key="v">{{ v }}</option>
            </select></label
          >
          <div class="studio-actions">
            <el-button
              @click="
                emit('pick', {
                  title: '为第 ' + (i + 1) + ' 句选择配音',
                  kinds: ['audio'],
                  target: { kind: 'audio', shotId: shot.id, lineId: line.id },
                })
              "
              >从媒体库选配音</el-button
            >
            <el-button
              :disabled="!canGenerate"
              @click="emit('generate', [], [line.id])"
              >重配此句</el-button
            ><el-button @click="shot.lines.splice(i, 1)">移除台词</el-button>
          </div>
          <div
            v-for="j in candidates(line.id)"
            :key="j.id"
            class="studio-actions"
          >
            <el-button @click="emit('preview', j)"
              >试听 · 版本 {{ j.revision }}</el-button
            ><el-button
              :aria-pressed="line.audio === j.id"
              @click="adoptVoice(line, j.id)"
            >
              {{ line.audio === j.id ? '已采用' : '采用' }}</el-button
            ><span
              v-if="line.start + (j.duration ?? 0) > shot.duration"
              class="studio-error"
              >配音超出镜头时长</span
            >
          </div>
          <StudioReferenceGroup
            v-if="line.audioAssetId"
            label="采用的库内配音"
            :project="project"
            :assets="assets.filter((asset) => asset.id === line.audioAssetId)"
            :readonly="readonly"
            add-label="更换"
            @choose="
              emit('pick', {
                title: '更换本句配音',
                kinds: ['audio'],
                target: { kind: 'audio', shotId: shot.id, lineId: line.id },
              })
            "
            @remove="line.audioAssetId = null"
          />
          <StudioMedia
            v-if="line.audioAssetId"
            :project="project"
            :asset="line.audioAssetId"
            kind="audio"
            controls
          />
        </fieldset>
        <el-button
          :disabled="!assets.some((a) => a.kind === 'character')"
          @click="addLine"
        >
          添加角色台词
        </el-button>
      </template>
    </fieldset>
    <template v-if="tab !== 'dialogue'" #footer>
      <div class="studio-toolbar">
        <el-button
          :disabled="!canGenerate || readonly"
          @click="emit('generate', [shot.id], [])"
          >生成此镜候选</el-button
        >
      </div>
    </template>
  </ScrollPanel>
</template>
<style scoped>
.inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.shot-inspector .inspector-fields {
  border: 0;
  padding: 0;
  margin: 0;
}
.shot-inspector :deep(.el-tabs__header) {
  margin: var(--control-gap) 0 0;
}
.shot-inspector :deep(.el-tabs__content) {
  display: none;
}
.shot-inspector :deep(.el-tabs__item) {
  padding-inline: 12px;
}
</style>
