<script setup lang="ts">
import type { StudioProject, StudioAsset } from '@/types/studio/studio'
import type { AssetUseTarget } from '@/utils/studio/asset-use'
import StudioReferenceGroup from './library/StudioReferenceGroup.vue'
import StudioSoundEffects from './library/StudioSoundEffects.vue'
import { computed, nextTick, type ComponentPublicInstance } from 'vue'
import DurationField from '@/components/form/DurationField.vue'
import LongTextField from '@/components/form/LongTextField.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import StudioSequence from './StudioSequence.vue'
import StudioMedia from './StudioMedia.vue'
import {
  moveShot,
  voiceConflict,
  voiceDurations,
} from '@/utils/studio/storyboard'
const p = defineModel<StudioProject>({ required: true })
const emit = defineEmits<{
  restore: [number]
  export: []
  preview: []
  select: [string]
  pick: [
    value: {
      title: string
      kinds: StudioAsset['kind'][]
      target: AssetUseTarget
    },
  ]
}>()
const props = defineProps<{
  readonly?: boolean
  busy: boolean
  preparing: boolean
  selected?: string
}>()
const active = computed(
  () =>
    p.value.document.shots.find((s) => s.id === props.selected) ??
    p.value.document.shots[0],
)
const panels = new Map<string, HTMLElement>()
const audioLengths = computed(() =>
  voiceDurations(p.value.jobs, p.value.assets),
)
function capturePanel(
  id: string,
  el: Element | ComponentPublicInstance | null,
) {
  if (el instanceof HTMLElement) panels.set(id, el)
  else panels.delete(id)
}
function sceneName(shot: StudioProject['document']['shots'][number]) {
  return (
    p.value.document.scenes?.find((scene) => scene.id === shot.sceneId)
      ?.title ||
    shot.scene ||
    '场景待定'
  )
}
async function focusShot(id: string) {
  emit('select', id)
  // 等待所选镜头展开后再定位，避免轨道点击落到仍折叠的编辑区。
  await nextTick()
  // 长文折叠和文本域自适应会在下一帧完成；再定位可避免滚到变高前的旧位置。
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  if (active.value?.id !== id) return
  panels.get(id)?.focus({ preventScroll: true })
  panels.get(id)?.scrollIntoView({ block: 'start' })
}
</script>
<template>
  <section class="panel studio-panel">
    <h2>剪辑时间线</h2>
    <div v-if="active" class="timeline-monitor">
      <div class="timeline-picture">
        <StudioMedia
          v-if="active.videoAssetId || active.candidate"
          :project="p.id"
          :job="active.candidate ?? undefined"
          :asset="active.videoAssetId ?? undefined"
          kind="video"
          controls
        />
        <span v-else>此镜尚未采用画面</span>
      </div>
      <div class="form-stack timeline-monitor-copy">
        <h3>
          镜 {{ p.document.shots.indexOf(active) + 1 }} ·
          {{ sceneName(active) }}
        </h3>
        <ExpandableText
          :text="active.action || '尚未填写镜头动作'"
          label="镜头要求"
          :lines="3"
        />
        <p>
          {{ active.camera || '未设景别' }} ·
          {{ ((active.trimEnd ?? active.duration) - active.trimStart) / 1000 }}
          秒
        </p>
        <router-link
          :to="{
            path: '/entertainment/' + p.id,
            query: { section: 'storyboard', shot: active.id },
          }"
          >返回分镜板</router-link
        >
      </div>
    </div>
    <StudioSequence
      v-if="p.document.shots.length"
      :document="p.document"
      :jobs="p.jobs"
      :assets="p.assets"
      :music-name="p.assets.find((a) => a.id === p.document.music)?.name"
      :selected="selected"
      @select="focusShot"
    />
    <details
      v-for="(s, i) in p.document.shots"
      :key="s.id"
      :ref="(el) => capturePanel(s.id, el)"
      tabindex="-1"
      class="timeline-shot-editor"
      :open="active?.id === s.id"
    >
      <summary class="timeline-shot-summary" @click.prevent="focusShot(s.id)">
        <strong>镜 {{ i + 1 }}</strong
        ><span :title="sceneName(s)">{{ sceneName(s) }}</span
        ><small
          >{{ ((s.trimEnd ?? s.duration) - s.trimStart) / 1000 }} 秒</small
        >
      </summary>
      <div class="timeline-shot-fields form-stack">
        <StudioReferenceGroup
          label="采用画面"
          :project="p.id"
          :assets="p.assets.filter((asset) => asset.id === s.videoAssetId)"
          :readonly="readonly"
          add-label="从媒体库选视频"
          :empty="
            s.candidate
              ? '当前采用本镜生成的画面，可选择库内视频替换。'
              : '此镜尚未采用画面。'
          "
          @choose="
            emit('pick', {
              title: '为镜 ' + (i + 1) + ' 选择视频',
              kinds: ['video'],
              target: { kind: 'video', shotId: s.id },
            })
          "
          @remove="s.videoAssetId = null"
        />
        <ExpandableText
          :text="s.action || '尚未填写镜头动作'"
          label="镜头要求"
          :lines="3"
        />
        <div class="studio-actions">
          <el-button
            :disabled="readonly || !i"
            @click="moveShot(p.document, i, i - 1)"
          >
            提前</el-button
          ><el-button
            :disabled="readonly || i === p.document.shots.length - 1"
            @click="moveShot(p.document, i, i + 1)"
          >
            延后</el-button
          >
          <DurationField
            :model-value="s.trimStart"
            label="入点"
            :disabled="readonly"
            :min="0"
            :max="s.duration"
            @update:model-value="s.trimStart = $event ?? 0"
          />
          <DurationField
            :model-value="s.trimEnd ?? s.duration"
            label="出点"
            :disabled="readonly"
            :min="0"
            :max="s.duration"
            @update:model-value="s.trimEnd = $event"
          />
        </div>
        <fieldset
          v-for="(line, lineIndex) in s.lines"
          :key="line.id"
          class="timeline-dialogue form-stack"
        >
          <legend>
            第 {{ lineIndex + 1 }} 句 ·
            {{
              p.assets.find((asset) => asset.id === line.role)?.name ||
              '角色台词'
            }}
          </legend>
          <ExpandableText :text="line.text" label="原台词" :lines="2" />
          <StudioReferenceGroup
            label="采用配音"
            :project="p.id"
            :assets="p.assets.filter((asset) => asset.id === line.audioAssetId)"
            :readonly="readonly"
            add-label="从媒体库选配音"
            :empty="line.audio ? '使用本句生成的配音' : '此句尚无配音'"
            @choose="
              emit('pick', {
                title:
                  '为镜 ' + (i + 1) + ' 第 ' + (lineIndex + 1) + ' 句选择配音',
                kinds: ['audio'],
                target: { kind: 'audio', shotId: s.id, lineId: line.id },
              })
            "
            @remove="line.audioAssetId = null"
          />
          <StudioMedia
            v-if="line.audioAssetId || line.audio"
            :project="p.id"
            :asset="line.audioAssetId ?? undefined"
            :job="line.audio ?? undefined"
            kind="audio"
            controls
          />
          <p v-if="voiceConflict(line, s, audioLengths)" class="studio-error">
            配音超出镜头时长
          </p>
          <LongTextField
            :model-value="line.subtitle ?? line.text"
            label="字幕"
            :min-rows="2"
            :max-rows="6"
            :disabled="readonly"
            @update:model-value="line.subtitle = $event"
          />
          <div class="timeline-field-grid">
            <DurationField
              :model-value="line.start"
              label="配音起点"
              :disabled="readonly"
              :min="0"
              @update:model-value="line.start = $event ?? 0"
            />
            <label class="field"
              >配音音量 · {{ Math.round(line.volume * 100) }}%<input
                v-model.number="line.volume"
                :disabled="readonly"
                type="range"
                min="0"
                max="2"
                step=".05"
            /></label>
          </div>
          <div class="timeline-field-grid">
            <DurationField
              :model-value="line.subtitleStart"
              label="字幕起点"
              :disabled="readonly"
              :min="0"
              :placeholder="line.start"
              @update:model-value="line.subtitleStart = $event"
            />
            <DurationField
              :model-value="line.end ?? s.duration"
              label="字幕终点"
              :disabled="readonly"
              :min="0"
              @update:model-value="line.end = $event"
            />
          </div>
        </fieldset>
        <StudioSoundEffects
          v-model="p.document"
          :project="p.id"
          :shot-id="s.id"
          :assets="p.assets"
          :readonly="readonly"
          @pick="emit('pick', $event)"
        />
      </div>
    </details>
    <StudioReferenceGroup
      label="背景音乐"
      :project="p.id"
      :assets="p.assets.filter((asset) => asset.id === p.document.music)"
      :readonly="readonly"
      add-label="从媒体库选择"
      @choose="
        emit('pick', {
          title: '选择作品背景音乐',
          kinds: ['audio', 'music'],
          target: { kind: 'music' },
        })
      "
      @remove="p.document.music = null"
    />
    <label class="field"
      >音乐音量<input
        v-model.number="p.document.musicVolume"
        :disabled="readonly"
        type="range"
        min="0"
        max="2"
        step=".05"
    /></label>
    <div class="studio-actions">
      <el-button
        :disabled="busy || preparing || !p.document.shots.length"
        @click="emit('preview')"
      >
        {{ preparing ? '正在准备预览…' : '预览当前剪辑' }}
      </el-button>
      <el-button
        :disabled="busy || !p.document.shots.length"
        @click="emit('export')"
      >
        导出 MP4
      </el-button>
    </div>
    <details class="timeline-history">
      <summary>工程版本 · {{ p.history.length }} 条记录</summary>
      <div class="form-stack">
        <div v-for="h in p.history" :key="h.revision" class="studio-actions">
          版本 {{ h.revision }} · {{ h.label }}
          <el-button
            v-if="h.revision !== p.revision"
            :disabled="readonly || busy"
            @click="emit('restore', h.revision)"
          >
            恢复此版
          </el-button>
        </div>
      </div>
    </details>
  </section>
</template>
<style scoped>
.timeline-monitor {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(140px, 1fr);
  gap: var(--field-gap);
  align-items: center;
  margin-bottom: var(--field-gap);
}
.timeline-monitor-copy {
  min-width: 0;
}
.timeline-monitor-copy h3 {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--font-size-section);
}
.timeline-monitor-copy p {
  margin: 0;
}
.timeline-shot-editor {
  min-width: 0;
  border-top: 1px solid var(--border);
  scroll-margin-block-start: var(--field-gap);
}
.timeline-shot-summary {
  display: flex;
  align-items: center;
  gap: var(--control-gap);
  min-height: 48px;
  padding-block: var(--control-gap);
  cursor: pointer;
}
.timeline-shot-summary::before {
  content: '›';
  color: var(--muted-foreground);
  transition: transform var(--transition-ui);
}
.timeline-shot-editor[open] > .timeline-shot-summary::before {
  transform: rotate(90deg);
}
.timeline-shot-summary strong,
.timeline-shot-summary small {
  flex: 0 0 auto;
}
.timeline-shot-summary span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-shot-summary small {
  color: var(--muted-foreground);
}
.timeline-shot-fields {
  padding-block: var(--control-gap) var(--field-gap);
}
.timeline-history {
  border-top: 1px solid var(--border);
  padding-top: var(--field-gap);
}
.timeline-history > div {
  padding-top: var(--field-gap);
}
.timeline-picture {
  display: grid;
  place-items: center;
  min-height: 240px;
  padding: var(--control-gap);
  width: 100%;
  overflow: hidden;
  border-radius: 8px;
  color: var(--studio-monitor-ink, #eee);
  background: var(--studio-monitor, #1b1c1e);
}
.timeline-picture :deep(.studio-media),
.timeline-picture :deep(.studio-frame) {
  width: 100%;
  height: auto;
  max-height: 48dvh;
  aspect-ratio: auto;
  object-fit: contain;
  margin: 0;
}
@media (max-width: 700px) {
  .timeline-monitor {
    grid-template-columns: minmax(0, 1fr);
  }
}
.timeline-field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--field-gap);
}
.timeline-dialogue legend {
  padding-inline: var(--control-gap);
  font-weight: 600;
}
</style>
