<script setup lang="ts">
import { computed } from 'vue'
import type { Job, Shot, StudioDocument } from '@/types/studio/studio'
import { voiceConflict, voiceDurations } from '@/utils/studio/storyboard'
const props = defineProps<{
  document: StudioDocument
  selected?: string
  jobs: Job[]
  musicName?: string
}>()
const emit = defineEmits<{ select: [string] }>()
const segments = computed(() =>
  props.document.shots.map((shot) => {
    const start = shot.trimStart
    const end = shot.trimEnd ?? shot.duration
    return { shot, start, end, length: Math.max(0, end - start) }
  }),
)
const total = computed(() => segments.value.reduce((n, s) => n + s.length, 0))
const tracks = ['画面', '配音', '字幕', '音乐'] as const
const audioLengths = computed(() => voiceDurations(props.jobs))
const marks = computed(() => {
  let start = 0
  return segments.value.map((segment) => {
    const mark = start
    start += segment.length
    return { ...segment, time: mark / 1000 }
  })
})
/** 将字幕与真实配音裁切到当前可见区间，避免剪去的台词继续占用轨道。 */
function cues(shot: Shot, track: '配音' | '字幕') {
  const cut = shot.trimStart,
    end = shot.trimEnd ?? shot.duration,
    length = end - cut
  if (length <= 0) return []
  return shot.lines.flatMap((line) => {
    const audio = track === '配音'
    const duration = line.audio ? audioLengths.value.get(line.audio) : undefined
    const label = audio ? line.text : (line.subtitle ?? line.text)
    if (!label || (audio && duration == null)) return []
    const start = audio ? line.start : (line.subtitleStart ?? line.start)
    const from = Math.max(cut, start)
    const to = Math.min(
      end,
      audio ? start + (duration ?? 0) : (line.end ?? end),
    )
    return from < to
      ? [
          {
            id: line.id,
            label,
            left: ((from - cut) / length) * 100 + '%',
            width: ((to - from) / length) * 100 + '%',
          },
        ]
      : []
  })
}
</script>
<template>
  <section class="panel studio-panel studio-sequence" aria-label="作品时间线">
    <header>
      <h2>时间线</h2>
      <span
        >{{ document.shots.length }} 镜 ·
        {{ (total / 1000).toLocaleString() }} 秒</span
      >
    </header>
    <div class="sequence-scroll">
      <div
        class="sequence-track"
        :style="{
          minWidth: Math.max(300, Math.min(12000, segments.length * 65)) + 'px',
        }"
      >
        <strong>秒</strong>
        <div class="sequence-cells sequence-ruler">
          <span
            v-for="mark in marks"
            :key="mark.shot.id"
            class="sequence-slot"
            :style="{ flexGrow: mark.length }"
            >{{ mark.time }}</span
          ><span>{{ total / 1000 }}</span>
        </div>
      </div>
      <div
        v-for="track in tracks"
        :key="track"
        class="sequence-track"
        :style="{
          minWidth: Math.max(300, Math.min(12000, segments.length * 65)) + 'px',
        }"
      >
        <strong>{{ track }}</strong>
        <div class="sequence-cells">
          <span
            v-if="track === '音乐' && document.music"
            class="sequence-music"
            >{{ musicName || '背景音乐' }}</span
          >
          <template v-else>
            <div
              v-for="(segment, i) in segments"
              :key="segment.shot.id"
              class="sequence-slot"
              :class="{
                'duration-conflict':
                  track === '配音' &&
                  segment.shot.lines.some((line) =>
                    voiceConflict(line, segment.shot, audioLengths),
                  ),
              }"
              :style="{ flexGrow: segment.length }"
            >
              <button
                v-if="track === '画面'"
                type="button"
                :aria-pressed="selected === segment.shot.id"
                :title="segment.shot.action"
                @click="emit('select', segment.shot.id)"
              >
                镜 {{ i + 1 }}
              </button>
              <template v-else-if="track === '配音' || track === '字幕'">
                <span
                  v-if="
                    track === '配音' &&
                    segment.shot.lines.some((line) =>
                      voiceConflict(line, segment.shot, audioLengths),
                    )
                  "
                  class="sequence-warning"
                  aria-label="配音超出镜头时长"
                  title="配音超出镜头时长"
                  >!</span
                >
                <span
                  v-for="cue in cues(segment.shot, track)"
                  :key="cue.id"
                  class="sequence-cue"
                  :class="{ voice: track === '配音' }"
                  :style="{ left: cue.left, width: cue.width }"
                  :title="cue.label"
                  >{{ cue.label }}</span
                >
              </template>
            </div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.sequence-ruler {
  font: 10px var(--font-mono);
  align-items: center;
  padding: 0 2px;
  color: var(--muted-foreground);
}
.sequence-slot.duration-conflict {
  box-shadow: inset 0 0 0 2px var(--destructive);
}
.sequence-warning {
  position: absolute;
  top: 1px;
  right: 3px;
  z-index: 1;
  color: var(--destructive);
  font-weight: bold;
}
.studio-sequence {
  min-width: 0;
}
.studio-sequence header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.studio-sequence h2 {
  margin: 0;
  font-size: 15px;
}
.studio-sequence header span,
.sequence-track strong {
  font-size: 12px;
  color: var(--muted-foreground);
}
.sequence-scroll {
  max-width: 100%;
  overflow: auto;
}
.sequence-track {
  display: grid;
  grid-template-columns: 3.25rem 1fr;
  align-items: stretch;
  gap: 5px;
  margin: 3px 0;
}
.sequence-track strong {
  align-self: center;
}
.sequence-cells {
  display: flex;
  overflow: hidden;
  min-height: 24px;
  gap: 1px;
  background: var(--muted);
  border-radius: 3px;
}
.sequence-slot {
  position: relative;
  flex-basis: 0;
  min-width: 0;
  overflow: hidden;
}
.sequence-slot button,
.sequence-cue,
.sequence-music {
  display: block;
  width: 100%;
  border: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  padding: 4px 5px;
  box-sizing: border-box;
}
.sequence-slot button {
  height: 100%;
  cursor: pointer;
  background: color-mix(in srgb, var(--primary) 26%, var(--card));
  color: var(--foreground);
}
.sequence-slot button[aria-pressed='true'] {
  box-shadow: inset 0 0 0 2px var(--primary);
}
.sequence-cue {
  position: absolute;
  height: 100%;
  background: color-mix(in srgb, #ab83cd 40%, var(--card));
}
.sequence-cue.voice {
  background: color-mix(in srgb, #4bb8ae 40%, var(--card));
}
.sequence-music {
  background: color-mix(in srgb, #729cc6 35%, var(--card));
}
</style>
