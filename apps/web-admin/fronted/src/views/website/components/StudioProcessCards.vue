<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import StudioFilmLoop from './StudioFilmLoop.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 以同一部短片演示八个制作步骤；访客可以按步选择，也可以单独预览试拍镜头。 */
const props = defineProps<{ playing: boolean }>()
defineEmits<{ preview: [src: string, title: string] }>()
const { tr } = usePreferences()
const phases = [
  {
    range: '01–02',
    title: ['构思故事', 'Find the story'],
    steps: [
      ['作品构想', 'Story idea'],
      ['剧本与场次', 'Script & scenes'],
    ],
  },
  {
    range: '03–04',
    title: ['准备开拍', 'Set the scene'],
    steps: [
      ['角色与场景', 'Cast & setting'],
      ['分镜设计', 'Storyboard'],
    ],
  },
  {
    range: '05–06',
    title: ['试拍与制作', 'Make the shots'],
    steps: [
      ['试做一镜', 'Sample shot'],
      ['批量制作', 'Production'],
    ],
  },
  {
    range: '07–08',
    title: ['完成与交付', 'Finish the film'],
    steps: [
      ['剪辑与字幕', 'Edit & subtitles'],
      ['成片交付', 'Delivery'],
    ],
  },
] as const
// 每一步都给出本片的实际创作决定，播放和手动选步共用同一组说明。
const notes = [
  [
    '想象一个雨停后还在站台等车的人。',
    'Picture a traveller still waiting after the rain.',
  ],
  ['写下她攥紧车票的动作。', 'Write the moment she grips her ticket.'],
  [
    '定下旅人的灰围巾和傍晚的站台。',
    'Choose her grey scarf and the station at dusk.',
  ],
  [
    '用远景交代站台，再切到她的脸。',
    'Establish the platform, then cut to her face.',
  ],
  ['先试一镜，看看雨后的光。', 'Try one shot to see the light after rain.'],
  [
    '沿用角色设定，补齐其余镜头。',
    'Keep the same character as you make the other shots.',
  ],
  [
    '按节奏接上镜头，配好字幕。',
    'Cut the shots to rhythm and set the subtitles.',
  ],
  ['看完最后一遍，交付短片。', 'Watch the final cut and deliver the film.'],
] as const
const shots = [
  {
    label: ['站台', 'Platform'],
    title: ['站台全景', 'Station panorama'],
    time: '00:00 – 00:04',
  },
  {
    label: ['车票', 'Ticket'],
    title: ['时刻表与车票', 'Timetable and tickets'],
    time: '00:04 – 00:07',
  },
  {
    label: ['雨棚', 'Canopy'],
    title: ['雨棚中景', 'Under the canopy'],
    time: '00:07 – 00:12',
  },
  {
    label: ['空车', 'Train'],
    title: ['远去的空车', 'Departing empty train'],
    time: '00:12 – 00:16',
  },
] as const
const selected = ref(1)
const shot = computed(() => shots[selected.value] ?? shots[1])
const step = ref(0)
const note = computed(() => notes[step.value] ?? notes[0])
const manual = ref(false)
const advancing = computed(() => props.playing && !manual.value)
function chooseStep(next: number) {
  step.value = next
  manual.value = true
}
function toggle() {
  if (!props.playing) return chooseStep((step.value + 1) % 8)
  if (step.value === 7) step.value = 0
  manual.value = !manual.value
}
// 只在此章可见时开始计时，切章、打开大图或卸载时由 Vue 清除定时器。
watchEffect((cleanup) => {
  if (!advancing.value) return
  const timer = window.setInterval(() => {
    step.value = Math.min(step.value + 1, 7)
    if (step.value === 7) manual.value = true
  }, 3500)
  cleanup(() => window.clearInterval(timer))
})
</script>

<template>
  <div class="process-spread">
    <StudioFilmLoop gallery :playing="playing" class="process-film-leader" />
    <div class="process-phases">
      <article
        v-for="(phase, index) in phases"
        :key="phase.range"
        class="process-phase"
        :data-current="Math.floor(step / 2) === index"
      >
        <header class="phase-heading">
          <h3>
            <small>{{ phase.range }}</small
            >{{ tr(phase.title[0], phase.title[1]) }}
          </h3>
          <div class="phase-steps">
            <template v-for="([zh, en], j) in phase.steps" :key="zh">
              <span v-if="j" aria-hidden="true">·</span>
              <button
                type="button"
                :aria-pressed="step === index * 2 + j"
                @click="chooseStep(index * 2 + j)"
              >
                {{ tr(zh, en) }}
              </button>
            </template>
          </div>
        </header>
        <div v-if="index === 0" class="phase-art process-script">
          <img :src="art.scriptPaper" alt="" loading="lazy" />
          <div class="process-script-copy">
            <h4>{{ tr('《雨后站台》', 'After the Rain') }}</h4>
            <small>{{
              tr('场次 1 · 外景 · 车站 · 傍晚', 'Scene 1 · EXT. Station · Dusk')
            }}</small>
            <p>
              {{
                tr(
                  '雨停了。她把车票攥在手心。',
                  'The rain stops. She holds the ticket tight.',
                )
              }}
            </p>
            <span>{{ tr('第 1 页', 'Page 1') }}</span>
          </div>
        </div>
        <div v-else-if="index === 1" class="phase-art process-boards">
          <img
            :src="art.stationBoards"
            :alt="
              tr(
                '雨后站台两格铅笔分镜',
                'Two pencil storyboards of the station',
              )
            "
            loading="lazy"
          />
          <button
            type="button"
            class="process-cast"
            :aria-label="tr('主角 / 旅人', 'Lead / traveller')"
            @click="
              $emit('preview', art.actor, tr('女主角设定', 'Lead character'))
            "
          >
            <img :src="art.actor" alt="" loading="lazy" />
          </button>
        </div>
        <section
          v-else-if="index === 2"
          class="phase-art process-takes"
          :aria-label="
            tr('雨后站台分镜预览', 'After the Rain storyboard preview')
          "
        >
          <div class="preview-view">
            <img
              :src="'/images/website/shot-' + (selected + 1) + '.webp'"
              :alt="tr(shot.title[0], shot.title[1])"
              loading="lazy"
            />
          </div>
          <div class="take-controls">
            <div class="preview-meta" aria-live="polite">
              <strong
                >{{ tr('镜头', 'Shot') }} 0{{ selected + 1 }} ·
                {{ tr(shot.title[0], shot.title[1]) }}</strong
              ><span>{{ shot.time }}</span>
            </div>
            <div
              class="take-tabs"
              role="group"
              :aria-label="tr('选择示例镜头', 'Choose a sample shot')"
            >
              <button
                v-for="(item, i) in shots"
                :key="item.time"
                type="button"
                :aria-pressed="selected === i"
                @click="selected = i"
              >
                {{ tr(item.label[0], item.label[1]) }}
              </button>
            </div>
          </div>
        </section>
        <button
          v-else
          type="button"
          class="phase-art process-final studio-print"
          @click="
            $emit(
              'preview',
              art.actor,
              tr('雨后站台 · 成片画面', 'After the Rain · Final frame'),
            )
          "
        >
          <img :src="art.actor" alt="" loading="lazy" /><span>{{
            tr('下一站，会遇见什么？', 'What waits at the next stop?')
          }}</span>
        </button>
      </article>
    </div>
    <div class="process-rail" :style="{ '--step': step }">
      <button
        type="button"
        :aria-label="
          !props.playing
            ? tr('查看下一步', 'View next step')
            : advancing
              ? tr('暂停流程演示', 'Pause walkthrough')
              : tr('播放流程演示', 'Play walkthrough')
        "
        @click="toggle"
      >
        <AppIcon :name="advancing ? 'circle-pause' : 'circle-play'" />
      </button>
      <div class="process-track" aria-hidden="true"><i /></div>
      <p class="process-detail">{{ tr(note[0], note[1]) }}</p>
      <span>{{ String(step + 1).padStart(2, '0') }} / 08</span>
    </div>
  </div>
</template>
