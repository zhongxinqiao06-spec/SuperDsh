<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'
const { tr } = usePreferences()
defineEmits<{ preview: [src: string, title: string] }>()
const selected = ref(1)
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
const shot = computed(() => shots[selected.value] ?? shots[1])
</script>

<template>
  <div class="studio-process-grid">
    <article class="studio-process-card studio-script-card">
      <div class="studio-step-heading">
        <span>01—02</span>
        <h3>{{ tr('构思故事', 'Find your story') }}</h3>
        <p>{{ tr('作品构想 · 剧本与场次', 'Brief · Script and scenes') }}</p>
      </div>
      <div class="studio-script-art">
        <div class="studio-script-paper">
          <small>STORY / 001</small>
          <h4>{{ tr('《雨后站台》', 'AFTER THE RAIN') }}</h4>
          <p>{{ tr('外景 · 车站 · 傍晚', 'EXT. STATION — DUSK') }}</p>
          <p>
            {{
              tr(
                '雨停了。她握着一张车票，抬头看向远方。',
                'The rain stops. Holding a ticket, she looks into the distance.',
              )
            }}
          </p>
          <span>{{
            tr('“下一站，会遇见什么？”', '“What waits at the next stop?”')
          }}</span>
          <div class="studio-script-lines" />
        </div>
        <span class="studio-paper-note">{{
          tr('每个故事，都始于一个念头。', 'Every story starts with an idea.')
        }}</span>
      </div>
      <p class="studio-step-description">
        {{
          tr(
            '写下构想，梳理场次。让灵感先成为讲得通的故事。',
            'Capture an idea and shape the scenes into a story.',
          )
        }}
      </p>
    </article>
    <article class="studio-process-card studio-cast-card">
      <div class="studio-step-heading">
        <span>03—04</span>
        <h3>{{ tr('准备开拍', 'Set the scene') }}</h3>
        <p>
          {{ tr('角色与场景 · 分镜设计', 'Cast and settings · Storyboard') }}
        </p>
      </div>
      <div class="studio-cast-art">
        <button
          @click="
            $emit('preview', art.actor, tr('女主角设定', 'Lead character'))
          "
        >
          <img :src="art.actor" alt="" loading="lazy" /><span>{{
            tr('主角 / 旅人', 'LEAD / TRAVELLER')
          }}</span>
        </button>
        <div class="studio-cast-strip">
          <img
            src="/images/website/shot-1.webp"
            :alt="tr('车站场景', 'Station setting')"
            loading="lazy"
          /><img
            src="/images/website/shot-3.webp"
            :alt="tr('雨棚分镜', 'Canopy shot')"
            loading="lazy"
          />
        </div>
        <div class="studio-cast-note">
          <i />
          {{
            tr(
              '角色、场景与镜头，逐一确认。',
              'Review cast, settings and shots.',
            )
          }}
        </div>
      </div>
      <p class="studio-step-description">
        {{
          tr(
            '定下角色与声音，安排镜头节奏。让故事有自己的样子。',
            'Choose characters and voices, then plan the visual rhythm.',
          )
        }}
      </p>
    </article>
    <article class="studio-process-card studio-takes-card">
      <div class="studio-step-heading">
        <span>05—06</span>
        <h3>{{ tr('试拍与制作', 'Explore the takes') }}</h3>
        <p>{{ tr('试做一镜 · 批量制作', 'Sample shot · Production') }}</p>
      </div>
      <section
        class="studio-shot-demo"
        :aria-label="
          tr('雨后站台分镜预览', 'After the Rain storyboard preview')
        "
      >
        <div class="preview-view">
          <img
            :src="'/images/website/shot-' + (selected + 1) + '.webp'"
            :alt="tr(shot.title[0], shot.title[1])"
            loading="lazy"
          /><span>AFTER THE RAIN / 0{{ selected + 1 }}</span>
        </div>
        <div class="preview-meta" aria-live="polite">
          <strong
            >{{ tr('镜头', 'Shot') }} 0{{ selected + 1 }} ·
            {{ tr(shot.title[0], shot.title[1]) }}</strong
          ><span>{{ shot.time }}</span>
        </div>
        <div
          class="studio-shot-selector"
          role="group"
          :aria-label="tr('选择示例镜头', 'Choose a sample shot')"
        >
          <button
            v-for="(item, index) in shots"
            :key="item.time"
            :aria-pressed="selected === index"
            @click="selected = index"
          >
            {{ tr(item.label[0], item.label[1]) }}
          </button>
        </div>
      </section>
      <p class="studio-step-description">
        {{
          tr(
            '先试一镜，再决定制作范围。逐镜比较，把喜欢的版本留下。',
            'Try a shot first, then choose the scope and the takes you love.',
          )
        }}
      </p>
    </article>
    <article class="studio-process-card studio-delivery-card">
      <div class="studio-step-heading">
        <span>07—08</span>
        <h3>{{ tr('完成与交付', 'Bring it together') }}</h3>
        <p>
          {{ tr('剪辑与字幕 · 成片交付', 'Edit and subtitles · Delivery') }}
        </p>
      </div>
      <div class="studio-delivery-art">
        <button
          @click="
            $emit(
              'preview',
              art.actor,
              tr('雨后站台 · 画面示意', 'After the Rain · Concept frame'),
            )
          "
        >
          <img :src="art.actor" alt="" loading="lazy" /><span>{{
            tr('下一站，会遇见什么？', 'What waits at the next stop?')
          }}</span>
        </button>
        <div class="studio-timeline" aria-hidden="true">
          <div><i /><i /><i /></div>
          <div><i /><i /></div>
          <div><i /><i /><i /><i /></div>
        </div>
        <div class="studio-export-label">
          <AppIcon name="check" /><span>{{
            tr('画面 / 配音 / 字幕', 'VIDEO / VOICE / SUBTITLES')
          }}</span
          ><b>MP4 ↗</b>
        </div>
      </div>
      <p class="studio-step-description">
        {{
          tr(
            '编排画面、配音和字幕。预览确认，再导出属于你的成片。',
            'Arrange video, voices and subtitles. Review, then export your film.',
          )
        }}
      </p>
    </article>
  </div>
</template>
