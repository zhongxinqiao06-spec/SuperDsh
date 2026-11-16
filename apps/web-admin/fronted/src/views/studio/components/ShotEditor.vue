<script setup lang="ts">
import type { StoryScene } from '@/types/studio/foundation'
import type { Job, Shot, StudioAsset } from '@/types/studio/studio'
import { onMounted, onScopeDispose, ref } from 'vue'
import { newId } from '@/utils/studio/storyboard'
const shot = defineModel<Shot>({ required: true })
const expanded = ref(true)
let viewport: MediaQueryList | undefined
function layout() {
  expanded.value = !viewport?.matches
}
onMounted(() => {
  viewport = window.matchMedia('(max-width:700px)')
  layout()
  viewport.addEventListener('change', layout)
})
onScopeDispose(() => viewport?.removeEventListener('change', layout))
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
  <section class="panel studio-panel">
    <header class="inspector-header">
      <h2>镜头设定</h2>
      <button
        class="inspector-toggle"
        type="button"
        :aria-expanded="expanded"
        aria-controls="studio-shot-fields"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起详情' : '展开详情' }}
      </button>
    </header>
    <fieldset
      v-show="expanded"
      id="studio-shot-fields"
      class="studio-form"
      :disabled="readonly"
    >
      <label class="field"
        >所属场次<select v-model="shot.sceneId" class="native-control">
          <option :value="null">按场景自动建立</option>
          <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
            {{ scene.title }}
          </option>
        </select></label
      >
      <label class="field"
        >动作摘要<textarea v-model="shot.action" class="native-control" />
      </label>
      <div class="studio-grid">
        <label class="field"
          >场景<input v-model="shot.scene" class="native-control" /></label
        ><label class="field"
          >景别<input v-model="shot.camera" class="native-control" /></label
        ><label class="field"
          >构图<input v-model="shot.framing" class="native-control" /></label
        ><label class="field"
          >运镜<input v-model="shot.movement" class="native-control" /></label
        ><label class="field"
          >时长（毫秒）<input
            v-model.number="shot.duration"
            class="native-control"
            type="number"
            min="1000"
            max="120000"
        /></label>
      </div>
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
      <div class="studio-toolbar">
        <el-button
          :disabled="!canGenerate"
          @click="emit('generate', [shot.id], [])"
          >生成此镜候选</el-button
        >
      </div>
      <h3>角色台词</h3>
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
        <label class="field"
          >台词<input v-model="line.text" class="native-control" /></label
        ><label class="field"
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
    </fieldset>
  </section>
</template>
<style scoped>
.inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.inspector-toggle {
  display: none;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 5px 10px;
}
@media (max-width: 700px) {
  .inspector-toggle {
    display: block;
  }
}
</style>
