<script setup lang="ts">
import type { StoryScene } from '@/types/studio/foundation'
import type { Job, Shot, StudioAsset } from '@/types/studio/studio'
import { ref } from 'vue'
import { newId } from '@/utils/studio/storyboard'
import LongTextField from '@/components/form/LongTextField.vue'
import DurationField from '@/components/form/DurationField.vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
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
const emit = defineEmits<{ preview: [Job]; generate: [string[], string[]] }>()
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
        <label class="field"
          >造型、场景与道具参考<select
            v-model="shot.references"
            class="native-control"
            multiple
          >
            <option v-for="a in assets" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select></label
        >
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
              @click="line.audio = j.id"
            >
              {{ line.audio === j.id ? '已采用' : '采用' }}</el-button
            ><span
              v-if="line.start + (j.duration ?? 0) > shot.duration"
              class="studio-error"
              >配音超出镜头时长</span
            >
          </div>
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
